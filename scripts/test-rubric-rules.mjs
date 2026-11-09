import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import ts from "typescript"

function moduleUrl(path, imports = {}) {
  let code = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText
  for (const [name, url] of Object.entries(imports)) code = code.replaceAll(JSON.stringify(name), JSON.stringify(url))
  return `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
}
const rubricUrl = moduleUrl("src/lib/rubric.ts")
const { validateRubric, validateGrading, rubricsEqual, essayApproved, suggestionMatches } = await import(rubricUrl)
const { checkEssayWithRules } = await import(moduleUrl("src/lib/rubric-rules.ts", { "./rubric": rubricUrl }))
const criterion = (mode = "proportional", concepts = "water | H2O\ncarbon dioxide | CO2\nsunlight | light energy") => ({
  id: "inputs", name: "Inputs", description: "Award points for required inputs.", max_points: 5,
  checking_rule: { mode, concepts },
})
const rubric = (...criteria) => ({ criteria })
const result = (c, answer) => checkEssayWithRules(rubric(c), answer).criteria[0]

test("whole-word and phrase matching accepts synonyms, case and punctuation, once per concept", () => {
  const answer = "H2O, water, WATER and carbon-dioxide provide inputs."
  const grade = result(criterion(), answer)
  assert.equal(grade.points, 3.33)
  assert.match(grade.reason, /2\/3 concepts matched/)
  assert.match(grade.reason, /Missing: sunlight/)
  assert.ok(answer.includes(grade.evidence))
  validateGrading({ criteria: [grade], feedback: "Review the draft." }, rubric(criterion()), answer)
  assert.equal(result(criterion("any", "water"), "Underwater wildlife.").points, 0)
  assert.equal(result(criterion("any", "carbon dioxide"), "carbon is not dioxide").points, 0)
})

test("all, any and equal-share policies respect point caps, blank answers and fractional limits", () => {
  assert.equal(result(criterion("all"), "Water and CO2").points, 0)
  assert.equal(result(criterion("all"), "Water, CO2, sunlight").points, 5)
  assert.equal(result(criterion("any"), "Sunlight").points, 5)
  for (const mode of ["all", "any", "proportional"]) {
    assert.equal(result(criterion(mode), "   ").points, 0)
    assert.equal(result(criterion(mode), "water CO2 sunlight water CO2 sunlight").points, 5)
  }
  const small = { ...criterion(), max_points: 0.015 }
  assert.equal(result(small, "water CO2 sunlight").points, 0.015)
  assert.equal(result(small, "water CO2").points, 0.01)
})

test("Unicode normalization keeps evidence as a verbatim answer substring", () => {
  const c = criterion("all", "café\nＦＵＬＬ\n你好")
  const answer = "CAFE\u0301 full 你好"
  const grade = result(c, answer)
  assert.equal(grade.points, 5)
  assert.ok(answer.includes(grade.evidence))
})

test("unconfigured subjective criteria remain unscored and checking never calls a network service", () => {
  const subjective = { id: "reasoning", name: "Reasoning", description: "Teacher evaluates correctness.", max_points: 5 }
  const previousFetch = globalThis.fetch
  globalThis.fetch = () => { throw new Error("Network calls are forbidden for rule checks") }
  try {
    const input = rubric(criterion(), subjective)
    const original = structuredClone(input)
    const draft = checkEssayWithRules(input, "water CO2 sunlight")
    assert.equal(draft.criteria[0].points, 5)
    assert.equal(draft.criteria[1].points, null)
    assert.match(draft.criteria[1].reason, /Teacher review required/)
    assert.match(draft.feedback, /not understanding or correctness/)
    assert.deepEqual(input, original)
  } finally { globalThis.fetch = previousFetch }
})

test("malformed or excessive concept rules cannot be saved or checked", () => {
  for (const rule of [null, { mode: "unknown", concepts: "water" }, { mode: "all", concepts: "" },
    { mode: "all", concepts: "water |" }, { mode: "all", concepts: "!!!" },
    { mode: "all", concepts: "Water\nWATER" }, { mode: "any", concepts: "carbon dioxide\ncarbon-dioxide" },
    { mode: "any", concepts: "x".repeat(101) }, { mode: "any", concepts: "x".repeat(2001) },
    { mode: "all", concepts: Array.from({ length: 21 }, (_, i) => `concept${i}`).join("\n") },
    { mode: "all", concepts: "one | two | three | four | five | six | seven" }]) {
    const input = rubric({ ...criterion(), checking_rule: rule })
    assert.throws(() => validateRubric(input))
    assert.throws(() => checkEssayWithRules(input, "anything"))
  }
})

test("rule-only edits invalidate approvals and cached suggestions regardless of JSON key order", () => {
  const original = rubric(criterion())
  const reordered = structuredClone(original)
  reordered.criteria[0].checking_rule = { concepts: criterion().checking_rule.concepts, mode: "proportional" }
  assert.equal(rubricsEqual(original, reordered), true)
  for (const rule of [{ mode: "all", concepts: criterion().checking_rule.concepts }, { mode: "proportional", concepts: "oxygen" }, undefined]) {
    const changed = rubric({ ...criterion(), checking_rule: rule })
    const snapshot = { prompt: "Explain inputs.", points: 5, rubric: original }
    const question = { ...snapshot, type: "essay", rubric: changed }
    assert.equal(rubricsEqual(original, changed), false)
    assert.equal(essayApproved(question, { overridden: true, approval_snapshot: snapshot }), false)
    assert.equal(suggestionMatches({ attempt: 1, answer_snapshot: "water", question_snapshot: snapshot }, question, "water", 1), false)
  }
})
