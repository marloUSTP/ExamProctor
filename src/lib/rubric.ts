import type { Answer, CriterionGrade, EssaySuggestion, Question, Rubric } from "./types"

export const MAX_RUBRIC_TEXT = 30000
export const MAX_CRITERIA = 12
export const MAX_RULE_TEXT = 2000

export function ruleWords(text: string): string[] {
  return text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
}

export function parseCheckingRule(value: unknown) {
  const rule = value as { mode?: unknown; concepts?: unknown } | null
  if (!rule || !["all", "any", "proportional"].includes(String(rule.mode)) ||
      typeof rule.concepts !== "string" || rule.concepts.length > MAX_RULE_TEXT) {
    throw new Error("Choose a valid checking mode and enter concept rules (up to 2,000 characters).")
  }
  const groups = rule.concepts.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    .map((line) => line.split("|").map((term) => term.trim()))
  if (!groups.length || groups.length > 20) throw new Error("Enter between 1 and 20 concepts, one per line.")
  const seen = new Set<string>()
  for (const group of groups) {
    if (group.length > 6) throw new Error("Use at most 6 accepted phrases per concept, separated by |.")
    for (const term of group) {
      const normalized = ruleWords(term).join(" ")
      if (!normalized || term.length > 100) throw new Error("Each accepted phrase needs letters or numbers and at most 100 characters.")
      if (seen.has(normalized)) throw new Error("Use each accepted phrase only once across this criterion's concepts.")
      seen.add(normalized)
    }
  }
  return { mode: rule.mode as "all" | "any" | "proportional", groups }
}

export function validateRubric(value: unknown, points?: number): Rubric {
  const rubric = value as Rubric | null
  if (!rubric || !Array.isArray(rubric.criteria) || !rubric.criteria.length || rubric.criteria.length > MAX_CRITERIA) {
    throw new Error(`Add between 1 and ${MAX_CRITERIA} rubric criteria.`)
  }
  const ids = new Set<string>()
  for (const c of rubric.criteria) {
    if (!c || typeof c.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(c.id) || ids.has(c.id)) {
      throw new Error("Each rubric criterion must have a unique ID.")
    }
    ids.add(c.id)
    if (typeof c.name !== "string" || !c.name.trim() || c.name.length > 200 ||
        typeof c.description !== "string" || !c.description.trim() || c.description.length > 4000) {
      throw new Error("Give every criterion a name and scoring descriptions (up to 4,000 characters).")
    }
    if (typeof c.max_points !== "number" || !Number.isFinite(c.max_points) || c.max_points <= 0 || c.max_points > 100) {
      throw new Error("Each criterion needs a point limit greater than 0 and at most 100.")
    }
    if (c.checking_rule !== undefined) parseCheckingRule(c.checking_rule)
  }
  const total = rubricTotal(rubric)
  if (total > 100 || (points !== undefined && Math.abs(total - points) > 0.000001)) {
    throw new Error(points === undefined ? "Rubric points cannot exceed 100." : `Rubric points (${total}) must equal the question's points (${points}).`)
  }
  return rubric
}

export function rubricTotal(rubric: Rubric): number {
  return Math.round(rubric.criteria.reduce((sum, c) => sum + c.max_points, 0) * 1000000) / 1000000
}

export function validateGrading(value: unknown, rubric: Rubric, answer?: string): { criteria: CriterionGrade[]; feedback: string } {
  const grade = value as { criteria: CriterionGrade[]; feedback: string } | null
  if (!grade || !Array.isArray(grade.criteria) || grade.criteria.length !== rubric.criteria.length ||
      typeof grade.feedback !== "string" || grade.feedback.length > 4000) {
    throw new Error("The grading response is incomplete. Try again or grade manually.")
  }
  const seen = new Set<string>()
  for (const c of grade.criteria) {
    const criterion = rubric.criteria.find((r) => r.id === c?.criterion_id)
    if (!criterion || seen.has(c.criterion_id) || typeof c.points !== "number" || !Number.isFinite(c.points) ||
        c.points < 0 || c.points > criterion.max_points || typeof c.reason !== "string" || !c.reason.trim() ||
        c.reason.length > 2000 || typeof c.evidence !== "string" || c.evidence.length > 2000) {
      throw new Error("The grading response contains invalid criterion scores. Try again or grade manually.")
    }
    if (answer !== undefined && c.evidence && !answer.includes(c.evidence)) {
      throw new Error("The suggested evidence does not match the student's answer. Try again or grade manually.")
    }
    seen.add(c.criterion_id)
  }
  return grade
}

export function essayApproved(q: Question, answer?: Pick<Answer, "overridden" | "approval_snapshot">): boolean {
  if (q.type !== "essay") return true
  const snapshot = answer?.approval_snapshot
  return !!answer?.overridden && !!snapshot && snapshot.prompt === q.prompt &&
    Number(snapshot.points) === Number(q.points) && rubricsEqual(snapshot.rubric, q.rubric)
}

export function suggestionMatches(s: Pick<EssaySuggestion, "attempt" | "answer_snapshot" | "question_snapshot">, q: Question, answer: string, attempt: number): boolean {
  return s.attempt === attempt && s.answer_snapshot === answer && s.question_snapshot.prompt === q.prompt &&
    Number(s.question_snapshot.points) === Number(q.points) && rubricsEqual(s.question_snapshot.rubric, q.rubric)
}

/** Same semantic field order in the browser and server, independent of JSONB object key order. */
export async function questionGradingFingerprint(question: Question): Promise<string> {
  const snapshot = [question.type, question.prompt, Number(question.points), question.rubric?.criteria.map((criterion) => [
    criterion.id, criterion.name, criterion.description, criterion.max_points,
    criterion.checking_rule ? [criterion.checking_rule.mode, criterion.checking_rule.concepts] : null,
  ]) ?? null]
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(snapshot)))
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

// JSONB may return object keys in a different order than the editor created them.
export function rubricsEqual(a: Rubric | null | undefined, b: Rubric | null | undefined): boolean {
  if (!a || !b) return !a && !b
  return a.criteria.length === b.criteria.length && a.criteria.every((c, i) => {
    const other = b.criteria[i]
    return c.id === other.id && c.name === other.name && c.description === other.description && c.max_points === other.max_points &&
      c.checking_rule?.mode === other.checking_rule?.mode && c.checking_rule?.concepts === other.checking_rule?.concepts
  })
}
