import type { SupabaseClient } from "@supabase/supabase-js"
import { AiError, aiConfig } from "./ai-providers"
import { extractRubric, gradeEssay } from "./essay-ai"
import { essayApproved, MAX_RUBRIC_TEXT, questionGradingFingerprint, suggestionMatches, validateRubric } from "./rubric"
import type { EssaySuggestion, Question } from "./types"

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } })

async function readBody(request: Request): Promise<Record<string, unknown>> {
  // Bound bytes even for chunked requests with no Content-Length header.
  const reader = request.body?.getReader()
  if (!reader) throw new AiError("A JSON request is required.", 400)
  let size = 0
  const chunks: Uint8Array[] = []
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 190000) { await reader.cancel(); throw new AiError("The request is too large.", 413) }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  try {
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
    const body = JSON.parse(new TextDecoder().decode(bytes))
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error()
    return body
  } catch { throw new AiError("Send a valid JSON object.", 400) }
}

/** The factory keeps auth, ownership, cache, and quota behavior testable without real API calls. */
export function teacherAiHandler(deps: {
  createClient: () => Promise<SupabaseClient>;
  config?: typeof aiConfig; extract?: typeof extractRubric; grade?: typeof gradeEssay
}) {
  return async (request: Request) => {
    let client: SupabaseClient | undefined
    let lease: string | undefined
    try {
      if (request.headers.get("origin") !== new URL(request.url).origin) throw new AiError("Use the AI controls from this application.", 403)
      if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new AiError("A JSON request is required.", 415)
      client = await deps.createClient()
      const { data: { user }, error: authError } = await client.auth.getUser()
      if (authError || !user) throw new AiError("Sign in as a teacher to use AI.", 401)
      const teacher = await client.rpc("is_teacher")
      if (teacher.error || teacher.data !== true) throw new AiError("Only teachers can use AI grading.", 403)
      const body = await readBody(request)
      let work: () => Promise<unknown>
      if (body.action === "extract-rubric") {
        if (typeof body.source !== "string" || !body.source.trim() || body.source.length > MAX_RUBRIC_TEXT ||
            typeof body.points !== "number" || !Number.isFinite(body.points) || body.points <= 0 || body.points > 100) {
          throw new AiError("Provide rubric text (up to 30,000 characters) and a question point limit from 1 to 100.", 400)
        }
        const { source, points } = body
        work = async () => ({ rubric: await (deps.extract ?? extractRubric)(source, points) })
      } else if (body.action === "grade-essay") {
        if (typeof body.sessionId !== "string" || !uuid.test(body.sessionId) || typeof body.questionId !== "string" || !uuid.test(body.questionId)) {
          throw new AiError("Choose a valid submitted answer.", 400)
        }
        const { data: session, error: sessionError } = await client.from("exam_sessions")
          .select("id,exam_id,status,attempt").eq("id", body.sessionId).maybeSingle()
        if (sessionError) throw new AiError("Could not load this submission. Check the database setup.", 503)
        if (!session) throw new AiError("Submission not found.", 404)
        if (body.expectedAttempt !== undefined && (!Number.isSafeInteger(body.expectedAttempt) || Number(body.expectedAttempt) < 1)) {
          throw new AiError("Provide a valid queued attempt.", 400)
        }
        if (body.expectedQuestionFingerprint !== undefined && (typeof body.expectedQuestionFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(body.expectedQuestionFingerprint))) {
          throw new AiError("Provide a valid queued question fingerprint.", 400)
        }
        const owned = await client.from("exams").select("id").eq("id", session.exam_id).eq("teacher_id", user.id).maybeSingle()
        if (owned.error || !owned.data) throw new AiError("Submission not found.", 404)
        if (body.expectedAttempt !== undefined && body.expectedAttempt !== session.attempt) throw new AiError("This student has a different attempt now. Prepare the queue again.", 409)
        if (!["submitted", "auto_submitted"].includes(session.status)) throw new AiError("Wait until this student submits the exam.", 409)
        const questionResult = await client.from("questions").select("id,exam_id,type,prompt,points,rubric")
          .eq("id", body.questionId).eq("exam_id", session.exam_id).maybeSingle()
        if (questionResult.error) throw new AiError("Could not load the rubric. Apply the rubric grading migration.", 503)
        const question = questionResult.data as Question | null
        if (!question || question.type !== "essay" || !question.rubric) throw new AiError("Save a rubric on this essay question first.", 422)
        try { validateRubric(question.rubric, question.points) } catch { throw new AiError("Correct and save the rubric point limits before grading.", 422) }
        if (body.expectedQuestionFingerprint !== undefined && body.expectedQuestionFingerprint !== await questionGradingFingerprint(question)) {
          throw new AiError("The question or rubric changed since this queue was prepared. Prepare the queue again.", 409)
        }
        const stored = await client.from("answers").select("*").eq("session_id", session.id).eq("question_id", question.id).maybeSingle()
        if (stored.error) throw new AiError("Could not load the answer.", 503)
        const answer = stored.data?.answer ?? ""
        if (typeof answer !== "string" || answer.length > 5000) throw new AiError("This answer exceeds the supported length.", 422)
        if (essayApproved(question, stored.data ?? undefined)) throw new AiError("This answer already has a teacher-approved score.", 409)
        const previous = await client.from("essay_suggestions").select("*").eq("session_id", session.id)
          .eq("question_id", question.id).eq("attempt", session.attempt).is("approved_at", null).order("created_at", { ascending: false })
        if (previous.error) throw new AiError("Apply the rubric grading migration before using AI suggestions.", 503)
        const cached = (previous.data as EssaySuggestion[]).find((s) => suggestionMatches(s, question, answer, session.attempt))
        if (cached) return reply({ suggestion: cached, cached: true })
        const db = client
        work = async () => {
          const result = await (deps.grade ?? gradeEssay)({ ...question, rubric: question.rubric! }, answer)
          const saved = await db.rpc("teacher_save_essay_suggestion", {
            p_session_id: session.id, p_question_id: question.id, p_attempt: session.attempt,
            p_answer: answer, p_snapshot: { prompt: question.prompt, points: question.points, rubric: question.rubric },
            p_grading: result.grading, p_model: result.model,
          })
          if (saved.error) throw new AiError("Could not save the suggestion. The submission or rubric may have changed; refresh before retrying.", 409)
          return { suggestion: saved.data, cached: false }
        }
      } else throw new AiError("Unknown AI action.", 400)
      ;(deps.config ?? aiConfig)()
      const claim = await client.rpc("teacher_claim_ai_request")
      if (claim.error) {
        if (claim.error.message.includes("AI_RATE_LIMIT")) throw new AiError("Another AI request is running, or you reached 10 requests this minute. Please wait before retrying.", 429)
        throw new AiError("AI request controls are unavailable. Apply the Gemini teacher requests migration.", 503)
      }
      if (typeof claim.data !== "string") throw new AiError("Could not reserve an AI request.", 503)
      lease = claim.data
      return reply(await work())
    } catch (error) {
      // Never expose raw auth, database, provider responses, or credentials.
      return reply({ error: error instanceof AiError ? error.message : "AI processing failed. Try again later or use manual grading." }, error instanceof AiError ? error.status : 500)
    } finally {
      if (client && lease) await client.rpc("teacher_release_ai_request", { p_lease: lease }).then(() => {}, () => {})
    }
  }
}
