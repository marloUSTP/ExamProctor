import { essayApproved, questionGradingFingerprint, suggestionMatches, validateRubric } from "./rubric"
import type { Answer, EssaySuggestion, ExamSession, Question } from "./types"

export type QueueAnswer = Pick<Answer, "session_id" | "question_id" | "answer" | "overridden" | "approval_snapshot">
export type QueueSuggestion = Pick<EssaySuggestion, "session_id" | "question_id" | "attempt" | "answer_snapshot" | "question_snapshot" | "approved_at">
export interface EssayQueueJob {
  id: string; sessionId: string; questionId: string; attempt: number; studentName: string; questionLabel: string
  fingerprint: string
  status: "pending" | "working" | "ready" | "skipped" | "failed"
  message?: string
}

export function queueableEssayQuestions(questions: Question[]): Question[] {
  return questions.filter((question) => {
    if (question.type !== "essay" || !question.rubric) return false
    try { validateRubric(question.rubric, question.points); return true } catch { return false }
  })
}

/** Prepare metadata only; answers stay out of queue state and no AI is called here. */
export async function buildEssayQueue(questions: Question[], sessions: ExamSession[], answers: QueueAnswer[], suggestions: QueueSuggestion[]): Promise<EssayQueueJob[]> {
  const essays = queueableEssayQuestions(questions).sort((a, b) => a.position - b.position)
  const fingerprints = new Map(await Promise.all(essays.map(async (question) => [question.id, await questionGradingFingerprint(question)] as const)))
  const storedAnswers = new Map(answers.map((answer) => [`${answer.session_id}:${answer.question_id}`, answer]))
  const proposals = new Map<string, QueueSuggestion[]>()
  for (const suggestion of suggestions) {
    const key = `${suggestion.session_id}:${suggestion.question_id}`
    proposals.set(key, [...(proposals.get(key) ?? []), suggestion])
  }
  return sessions.filter((session) => ["submitted", "auto_submitted"].includes(session.status))
    .sort((a, b) => a.student_name.localeCompare(b.student_name)).flatMap((session) => essays.map((question) => {
      const key = `${session.id}:${question.id}`
      const answer = storedAnswers.get(key)
      const approved = essayApproved(question, answer)
      const cached = (proposals.get(key) ?? []).some((suggestion) => !suggestion.approved_at && suggestionMatches(suggestion, question, answer?.answer ?? "", session.attempt))
      return {
        id: `${key}:${session.attempt}`, sessionId: session.id, questionId: question.id, attempt: session.attempt,
        studentName: session.student_name, questionLabel: `Q${question.position + 1}: ${question.prompt.slice(0, 100)}`,
        fingerprint: fingerprints.get(question.id)!,
        status: approved ? "skipped" as const : cached ? "ready" as const : "pending" as const,
        message: approved ? "Already teacher approved" : cached ? "Saved suggestion already available" : undefined,
      }
    }))
}

export function waitForEssayQueue(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) { resolve(); return }
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve() }
    const timer = setTimeout(finish, ms)
    signal.addEventListener("abort", finish, { once: true })
  })
}

/** One request at a time, at most about nine starts/minute; never approves or changes scores. */
export async function runEssayQueue(jobs: EssayQueueJob[], options: {
  request: (job: EssayQueueJob) => Promise<{ cached: boolean }>
  update: (jobs: EssayQueueJob[]) => void
  shouldPause: () => boolean
  wait: (ms: number) => Promise<void>
  clock: { nextStartAt: number }
  now?: () => number
}): Promise<{ jobs: EssayQueueJob[]; status: "completed" | "paused"; reason?: string }> {
  let current: EssayQueueJob[] = jobs.map((job) => ({ ...job, status: job.status === "working" ? "pending" as const : job.status }))
  const now = options.now ?? Date.now
  function patch(index: number, update: Partial<EssayQueueJob>) {
    current = current.map((job, i) => i === index ? { ...job, ...update } : job)
    options.update(current)
  }
  for (let index = 0; index < current.length; index++) {
    if (current[index].status !== "pending") continue
    let retries = 0
    while (current[index].status === "pending") {
      if (options.shouldPause()) return { jobs: current, status: "paused" }
      await options.wait(Math.max(0, options.clock.nextStartAt - now()))
      if (options.shouldPause()) return { jobs: current, status: "paused" }
      patch(index, { status: "working", message: undefined })
      options.clock.nextStartAt = now() + 7000
      try {
        const result = await options.request(current[index])
        patch(index, { status: "ready", message: result.cached ? "Saved suggestion reused" : "New suggestion saved; awaiting teacher approval" })
      } catch (error) {
        const status = error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : 0
        const message = error instanceof Error ? error.message : "Could not request this suggestion."
        if (status === 409) { patch(index, { status: "skipped", message }); continue }
        if (status === 422) { patch(index, { status: "failed", message }); continue }
        if (status === 0 || status === 408 || status === 429 || status >= 500) {
          // Keep the same item pending: the server will reuse a saved suggestion if
          // the response was lost after generation. Back off without overlapping requests.
          const retryMs = Math.min(300000, (status === 429 ? 60000 : 15000) * 2 ** Math.min(retries++, 5))
          options.clock.nextStartAt = Math.max(options.clock.nextStartAt, now() + retryMs)
          patch(index, { status: "pending", message: `${message} Retrying automatically in ${retryMs / 1000} seconds…` })
          continue
        }
        patch(index, { status: "pending", message })
        return { jobs: current, status: "paused", reason: message }
      }
    }
  }
  return { jobs: current, status: "completed" }
}
