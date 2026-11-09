import { parseCheckingRule, ruleWords, validateRubric } from "./rubric"
import type { CriterionGrade, Rubric } from "./types"

export interface RuleDraft {
  criteria: (Omit<CriterionGrade, "points"> & { points: number | null })[]
  feedback: string
}

/** Teacher-side draft only. Approval still uses the existing snapshot-checked RPC. */
export function checkEssayWithRules(rubric: Rubric, answer: string): RuleDraft {
  validateRubric(rubric)
  const tokens = Array.from(answer.matchAll(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu), (match) => ({
    words: ruleWords(match[0]), start: match.index!, end: match.index! + match[0].length,
  }))
  // Preserve original answer offsets even when Unicode normalization expands a word.
  const words = tokens.flatMap((token) => token.words.map((word) => ({ ...token, word })))
  function findPhrase(phrase: string) {
    const expected = ruleWords(phrase)
    for (let i = 0; i <= words.length - expected.length; i++) {
      if (expected.every((word, offset) => words[i + offset].word === word)) {
        return answer.slice(words[i].start, words[i + expected.length - 1].end)
      }
    }
    return undefined
  }

  return {
    criteria: rubric.criteria.map((criterion) => {
      if (!criterion.checking_rule) return {
        criterion_id: criterion.id, points: null, reason: "Teacher review required: no concept rules configured.", evidence: "",
      }
      const { mode, groups } = parseCheckingRule(criterion.checking_rule)
      const matches = groups.map((group) => group.map(findPhrase).find((match) => match !== undefined))
      const count = matches.filter((match) => match !== undefined).length
      const fraction = mode === "all" ? Number(count === groups.length) : mode === "any" ? Number(count > 0) : count / groups.length
      // Round partial points down to hundredths and never exceed the teacher's cap.
      const points = fraction === 1 ? criterion.max_points : Math.min(criterion.max_points,
        Math.floor(criterion.max_points * fraction * 100 + 1e-9) / 100)
      const missing = groups.filter((_, index) => matches[index] === undefined).map((group) => group[0])
      const matched = matches.filter((match) => match !== undefined)
      const policy = mode === "all" ? "All concepts required for full points." : mode === "any" ? "Any concept earns full points." : "Each concept earns an equal share; partial points rounded down to 0.01."
      return {
        criterion_id: criterion.id, points,
        reason: `Rule check: ${count}/${groups.length} concepts matched. ${policy}${matched.length ? ` Matched: ${matched.join(", ")}.` : ""}${missing.length ? ` Missing: ${missing.join(", ")}.` : ""} Review meaning and correctness.`.slice(0, 2000),
        evidence: matched.find((match) => match.length <= 2000) ?? "",
      }
    }),
    feedback: "Rule-based draft: checks configured words and phrases, not understanding or correctness. Review every criterion before approving; criteria without rules need a teacher score.",
  }
}
