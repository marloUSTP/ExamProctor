import type { EssaySuggestion, Rubric } from "./types"

export class TeacherAiRequestError extends Error {
  constructor(message: string, public status: number) { super(message) }
}

export async function requestTeacherAi(body: { action: "extract-rubric"; source: string; points: number }): Promise<{ rubric: Rubric }>
export async function requestTeacherAi(body: { action: "grade-essay"; sessionId: string; questionId: string; expectedAttempt?: number; expectedQuestionFingerprint?: string }): Promise<{ suggestion: EssaySuggestion; cached: boolean }>
export async function requestTeacherAi(body: unknown) {
  const response = await fetch("/api/teacher/ai", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(75000),
  })
  const result = await response.json().catch(() => null)
  if (!response.ok || !result) throw new TeacherAiRequestError(result?.error || "AI processing could not finish. Try again later or continue manually.", response.ok ? 502 : response.status)
  return result
}
