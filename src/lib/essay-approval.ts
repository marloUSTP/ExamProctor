import { essayApproved, suggestionMatches, validateGrading, validateRubric } from "./rubric"
import type { Answer, EssaySuggestion, ExamSession, Question } from "./types"

export type ApprovalAnswer = Pick<Answer, "session_id" | "question_id" | "answer" | "overridden" | "approval_snapshot"> &
  Partial<Pick<Answer, "points_awarded" | "rubric_grading">>
export type ApprovalSession = Pick<ExamSession, "id" | "student_name" | "student_email" | "status" | "attempt">
export interface EssayApprovalItem {
  id: string
  session: ApprovalSession
  question: Question
  answer: string
  suggestion?: EssaySuggestion
  grading?: EssaySuggestion["grading"]
  status: "ready" | "approved" | "missing" | "stale" | "invalid"
  total?: number
  message?: string
}

/** One current draft per answer; old attempts and changed rubrics cannot be selected. */
export function buildEssayApprovals(questions: Question[], sessions: ApprovalSession[], answers: ApprovalAnswer[], suggestions: EssaySuggestion[]): EssayApprovalItem[] {
  const stored = new Map(answers.map((answer) => [`${answer.session_id}:${answer.question_id}`, answer]))
  const proposals = new Map<string, EssaySuggestion[]>()
  for (const suggestion of suggestions) {
    const key = `${suggestion.session_id}:${suggestion.question_id}`
    const list = proposals.get(key) ?? []
    list.push(suggestion)
    proposals.set(key, list)
  }
  const essays = questions.filter((q) => q.type === "essay" && q.rubric).sort((a, b) => a.position - b.position)
  return sessions.filter((s) => ["submitted", "auto_submitted"].includes(s.status))
    .sort((a, b) => a.student_name.localeCompare(b.student_name)).flatMap((session) => essays.map((question): EssayApprovalItem => {
      const key = `${session.id}:${question.id}`
      const answer = stored.get(key)
      const item: EssayApprovalItem = { id: `${key}:${session.attempt}`, session, question, answer: answer?.answer ?? "", status: "missing" }
      if (essayApproved(question, answer)) return { ...item, status: "approved", grading: answer?.rubric_grading ?? undefined,
        total: answer?.points_awarded == null ? undefined : Number(answer.points_awarded) }
      try { validateRubric(question.rubric, question.points) }
      catch { return { ...item, status: "invalid", message: "Save a valid rubric before approving this answer." } }
      const drafts = (proposals.get(key) ?? []).filter((s) => !s.approved_at)
      const suggestion = drafts.filter((s) => suggestionMatches(s, question, item.answer, session.attempt))
        .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))[0]
      if (!suggestion) return { ...item, status: drafts.length ? "stale" : "missing",
        message: drafts.length ? "The answer, attempt or rubric changed. Generate a new suggestion." : "Generate an AI suggestion or grade this answer individually." }
      try {
        const grading = validateGrading(suggestion.grading, question.rubric!, item.answer)
        const total = Math.round(grading.criteria.reduce((sum, c) => sum + c.points, 0) * 1000000) / 1000000
        return { ...item, suggestion, grading, status: "ready", total }
      } catch {
        return { ...item, status: "invalid", message: "The suggested scores or evidence need correction. Review and edit this answer individually." }
      }
    }))
}

export interface ApprovalOutcome { id: string; status: "approved" | "stale" | "failed"; message?: string }

/** Explicit selections only. Each RPC checks ownership, answer, attempt, rubric and prior approval again. */
export async function approveEssaySelection(items: EssayApprovalItem[], selected: Set<string>, options: {
  approve: (suggestion: EssaySuggestion) => Promise<void>
  update: (outcome: ApprovalOutcome) => void
  shouldStop: () => boolean
}): Promise<ApprovalOutcome[]> {
  const outcomes: ApprovalOutcome[] = []
  const seen = new Set<string>()
  for (const item of items) {
    const suggestion = item.suggestion
    if (options.shouldStop()) break
    if (item.status !== "ready" || !suggestion || !selected.has(suggestion.id) || seen.has(item.id)) continue
    seen.add(item.id)
    let outcome: ApprovalOutcome
    let stop = false
    try {
      validateGrading(suggestion.grading, item.question.rubric!, item.answer)
      await options.approve(suggestion)
      outcome = { id: suggestion.id, status: "approved" }
    } catch (error) {
      const message = (error as { message?: string })?.message ?? "Approval could not be confirmed. Refresh before trying again."
      const stale = message.includes("STALE_GRADING")
      outcome = { id: suggestion.id, status: stale ? "stale" : "failed",
        message: stale ? "The answer, rubric or approval changed. Refresh and review this item again." : message }
      // An expired login or lost connection requires attention; never blindly retry a write.
      stop = !stale && !/INVALID_(GRADING|SCORE|EVIDENCE)/.test(message)
    }
    outcomes.push(outcome)
    options.update(outcome)
    if (stop) break
  }
  return outcomes
}
