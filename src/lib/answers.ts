import type { QuestionType } from "@/lib/types"

const LETTERS = "ABCDEFGHIJ"

/**
 * Human-readable form of a stored answer ("1" → "B. Cebu", "true" → "True").
 * Students see choices shuffled, so their pages pass withLetter=false (the teacher's letters would confuse them).
 */
export function formatAnswer(
  type: QuestionType,
  choices: string[],
  value: string | null | undefined,
  withLetter = true
): string {
  if (value === null || value === undefined || value === "") return "No answer"
  if (type === "multiple_choice") {
    const i = Number(value)
    if (!Number.isInteger(i) || choices[i] === undefined) return value
    return withLetter ? `${LETTERS[i]}. ${choices[i]}` : choices[i]
  }
  if (type === "true_false") return value === "true" ? "True" : value === "false" ? "False" : value
  if (type === "essay") return value || "No response"
  return value
}

export function formatKey(type: QuestionType, choices: string[], correct: string[], withLetter = true): string {
  if (type === "identification") return correct.join(" / ")
  if (type === "essay") return correct.length ? correct.join(" / ") : "(Manual grading)"
  return formatAnswer(type, choices, correct[0], withLetter)
}

export function percent(score: number | null, max: number | null): number | null {
  if (score === null || !max) return null
  return Math.round((Number(score) / Number(max)) * 100)
}
