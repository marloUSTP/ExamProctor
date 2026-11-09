import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import ts from "typescript"

function moduleUrl(path, imports = {}) {
  let code = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
  for (const [name, url] of Object.entries(imports)) code = code.replaceAll(JSON.stringify(name), JSON.stringify(url))
  return `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
}
const rubricUrl = moduleUrl("src/lib/rubric.ts")
const approvalUrl = moduleUrl("src/lib/essay-approval.ts", { "./rubric": rubricUrl })
const { buildEssayApprovals, approveEssaySelection } = await import(approvalUrl)
const { loadEssayApprovals } = await import(moduleUrl("src/lib/essay-approval-client.ts", { "./essay-approval": approvalUrl }))
const rubric = { criteria: [{ id: "content", name: "Content", description: "Explain the concept.", max_points: 10 }] }
const question = { id: "q1", type: "essay", prompt: "Explain encryption", points: 10, rubric, position: 0 }
const session = { id: "s1", student_name: "Alice", student_email: "alice@example.com", status: "submitted", attempt: 1 }
const snapshot = { prompt: question.prompt, points: question.points, rubric }
const answer = { session_id: session.id, question_id: question.id, answer: "Encryption protects data.", overridden: false }
const grading = { criteria: [{ criterion_id: "content", points: 6.5, reason: "Partially explains protection", evidence: "protects data" }], feedback: "Add an example." }
const suggestion = { id: "draft1", session_id: session.id, question_id: question.id, attempt: 1, answer_snapshot: answer.answer,
  question_snapshot: snapshot, grading, model: "local:test", created_at: "2026-10-29T01:00:00Z", approved_at: null }
const rows = (suggestions = [suggestion], answers = [answer], questions = [question], sessions = [session]) => buildEssayApprovals(questions, sessions, answers, suggestions)

test("checklist shows one current suggestion per submitted answer, with fractional totals", () => {
  const result = rows()
  assert.equal(result.length, 1)
  assert.equal(result[0].status, "ready")
  assert.equal(result[0].total, 6.5)
  assert.equal(result[0].answer, answer.answer)
  assert.equal(result[0].suggestion.grading, grading)
  assert.equal(rows([suggestion], [answer], [question], [{ ...session, status: "in_progress" }]).length, 0)
  assert.equal(rows([suggestion], [answer], [{ ...question, type: "multiple_choice" }]).length, 0)
})

test("checklist reuses the newest matching draft regardless of database ordering", () => {
  const newer = { ...suggestion, id: "draft2", created_at: "2026-10-29T02:00:00Z", grading: { ...grading, feedback: "Newest feedback" } }
  for (const list of [[suggestion, newer], [newer, suggestion]]) assert.equal(rows(list)[0].suggestion.id, "draft2")
  assert.equal(rows([{ ...newer, answer_snapshot: "Old answer" }, suggestion])[0].suggestion.id, "draft1")
})

test("already approved answers cannot be selected, even with another unused suggestion", () => {
  const result = rows([suggestion], [{ ...answer, overridden: true, approval_snapshot: snapshot, points_awarded: 6.5, rubric_grading: grading }])
  assert.equal(result[0].status, "approved")
  assert.equal(result[0].suggestion, undefined)
  assert.equal(result[0].total, 6.5)
  assert.equal(result[0].grading, grading)
})

test("changed answers, attempts, rubrics and question points are marked stale", () => {
  for (const change of [{ answer_snapshot: "Old answer" }, { attempt: 2 },
    { question_snapshot: { ...snapshot, prompt: "Old prompt" } },
    { question_snapshot: { ...snapshot, points: 9 } },
    { question_snapshot: { ...snapshot, rubric: { criteria: [{ ...rubric.criteria[0], description: "Old rubric" }] } } }]) {
    assert.equal(rows([{ ...suggestion, ...change }])[0].status, "stale")
  }
  assert.equal(rows([])[0].status, "missing")
  assert.equal(rows([{ ...suggestion, approved_at: "2026-10-29T02:00:00Z" }])[0].status, "missing")
})

test("invalid scores, missing criteria, fabricated evidence and invalid rubrics cannot be selected", () => {
  for (const invalid of [{ ...grading, criteria: [] }, { ...grading, criteria: [{ ...grading.criteria[0], points: 11 }] },
    { ...grading, criteria: [{ ...grading.criteria[0], evidence: "made up evidence" }] }]) {
    assert.equal(rows([{ ...suggestion, grading: invalid }])[0].status, "invalid")
  }
  assert.equal(rows([suggestion], [answer], [{ ...question, points: 9 }])[0].status, "invalid")
})

test("zero scores and blank essays can be explicitly approved", () => {
  const blank = { ...answer, answer: "" }
  const zero = { ...suggestion, answer_snapshot: "", grading: { feedback: "No response", criteria: [{ ...grading.criteria[0], points: 0, evidence: "" }] } }
  assert.equal(rows([zero], [blank])[0].status, "ready")
  assert.equal(rows([zero], [blank])[0].total, 0)
})

function approvalRunner(overrides = {}) {
  const calls = [], updates = []
  return { calls, updates, options: { approve: async (s) => { calls.push(s) }, update: (r) => updates.push(r), shouldStop: () => false, ...overrides } }
}
function manyRows() {
  return [1, 2, 3].flatMap((n) => rows([{ ...suggestion, id: `draft${n}`, session_id: `s${n}` }],
    [{ ...answer, session_id: `s${n}` }], [question], [{ ...session, id: `s${n}`, student_name: `Student ${n}` }]))
}

test("approval writes only explicitly selected current drafts once, preserving exact rubric grades", async () => {
  const r = approvalRunner()
  const input = manyRows()
  const result = await approveEssaySelection([...input, input[0]], new Set(["draft1", "draft3", "unrelated"]), r.options)
  assert.deepEqual(r.calls.map((s) => s.id), ["draft1", "draft3"])
  assert.ok(r.calls.every((s) => s.grading === grading))
  assert.ok(result.every((r) => r.status === "approved"))
  assert.ok(input.every((r) => r.status === "ready"), "does not mutate review data")
})

test("unchecked, approved, stale and invalid rows never write a grade", async () => {
  const r = approvalRunner()
  await approveEssaySelection(rows(), new Set(), r.options)
  for (const status of ["approved", "stale", "invalid", "missing"]) {
    await approveEssaySelection(rows().map((row) => ({ ...row, status })), new Set([suggestion.id]), r.options)
  }
  assert.equal(r.calls.length, 0)
})

test("approvals are sequential and stale failures do not prevent later selected approvals", async () => {
  let active = 0
  const r = approvalRunner({ approve: async (s) => {
    assert.equal(active++, 0)
    await Promise.resolve()
    active--
    if (s.id === "draft2") throw new Error("STALE_GRADING")
  } })
  const result = await approveEssaySelection(manyRows(), new Set(["draft1", "draft2", "draft3"]), r.options)
  assert.deepEqual(result.map((r) => r.status), ["approved", "stale", "approved"])
  assert.equal(r.updates.length, 3)
})

test("login and network failures stop remaining writes without an automatic retry", async () => {
  for (const error of [new Error("FORBIDDEN"), new TypeError("Failed to fetch")]) {
    let calls = 0
    const r = approvalRunner({ approve: async () => { calls++; throw error } })
    const result = await approveEssaySelection(manyRows(), new Set(["draft1", "draft2", "draft3"]), r.options)
    assert.equal(calls, 1)
    assert.equal(result.length, 1)
    assert.equal(result[0].status, "failed")
  }
})

test("stopping or unmounting lets the current write finish and leaves the rest unprocessed", async () => {
  let stop = false
  const r = approvalRunner({ shouldStop: () => stop, approve: async () => { stop = true } })
  const result = await approveEssaySelection(manyRows(), new Set(["draft1", "draft2", "draft3"]), r.options)
  assert.equal(result.length, 1)
  assert.equal(result[0].status, "approved")
})

function fakeClient(answers, suggestions, failure) {
  const pages = []
  return { pages, from(table) {
    const query = { select: () => query, in: () => query, is: () => query,
      order: (field) => { assert.ok(table !== "answers" || field !== "id"); return query },
      range: async (start, end) => { pages.push([table, start]); return failure ? { error: failure }
        : { data: (table === "answers" ? answers : suggestions).slice(start, end + 1) } },
    }
    return query
  } }
}

test("loading paginates suggestions and answers beyond the database row limit", async () => {
  const answers = Array.from({ length: 1001 }, (_, n) => ({ ...answer, session_id: `other${n}` }))
  const drafts = Array.from({ length: 1001 }, (_, n) => ({ ...suggestion, id: `other${n}`, session_id: `other${n}` }))
  const client = fakeClient([...answers, answer], [...drafts, suggestion])
  const result = await loadEssayApprovals(client, [question], [session])
  assert.equal(result[0].status, "ready")
  assert.equal(result[0].suggestion.id, suggestion.id)
  assert.deepEqual(client.pages.filter(([table]) => table === "essay_suggestions").map(([, start]) => start), [0, 500, 1000])
})

test("read failures and cancellation cannot return an incomplete approval checklist", async () => {
  await assert.rejects(loadEssayApprovals(fakeClient([], [], new Error("Read failed")), [question], [session]), /Read failed/)
  await assert.rejects(loadEssayApprovals(fakeClient([], []), [question], [session], () => true), /stopped/)
})
