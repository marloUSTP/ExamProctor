import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import ts from "typescript"

function moduleUrl(path, imports = {}) {
  let code = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
  for (const [name, url] of Object.entries(imports)) code = code.replaceAll(JSON.stringify(name), JSON.stringify(url))
  return `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
}
const rubricUrl = moduleUrl("src/lib/rubric.ts")
const queueUrl = moduleUrl("src/lib/essay-queue.ts", { "./rubric": rubricUrl })
const { questionGradingFingerprint } = await import(rubricUrl)
const { buildEssayQueue, runEssayQueue, waitForEssayQueue } = await import(queueUrl)
const { loadEssayQueue } = await import(moduleUrl("src/lib/essay-queue-client.ts", { "./essay-queue": queueUrl }))
const rubric = { criteria: [{ id: "content", name: "Content", description: "Explain the concept.", max_points: 10 }] }
const question = { id: "q1", type: "essay", prompt: "Explain encryption", points: 10, rubric, position: 0 }
const session = { id: "s1", student_name: "Alice", status: "submitted", attempt: 1 }
const snapshot = { prompt: question.prompt, points: question.points, rubric }
const answer = { session_id: session.id, question_id: question.id, answer: "Encryption protects data.", overridden: false }
const suggestion = { ...answer, attempt: 1, answer_snapshot: answer.answer, question_snapshot: snapshot, approved_at: null }
const jobs = () => [1, 2, 3].map((id) => ({ id: String(id), sessionId: `s${id}`, questionId: "q1", studentName: `Student ${id}`, questionLabel: "Q1", attempt: 1, fingerprint: "hash", status: "pending" }))
function runner(options = {}) {
  let time = 0
  const calls = []
  const updates = []
  const defaults = {
    clock: { nextStartAt: 0 }, now: () => time, wait: async (ms) => { time += ms },
    shouldPause: () => false, update: (list) => updates.push(structuredClone(list)),
    request: async (job) => { calls.push({ id: job.id, time }); return { cached: false } },
  }
  return { calls, updates, options: { ...defaults, ...options } }
}

test("only finished sessions and valid rubric essays enter the list, ordered by student then question", async () => {
  const list = await buildEssayQueue([question, { ...question, id: "invalid", points: 20 }, { ...question, id: "mcq", type: "multiple_choice" }, { ...question, id: "q2", position: 1 }],
    [{ ...session, id: "s2", student_name: "Bob" }, { ...session, id: "s3", status: "in_progress" }, session], [], [])
  assert.deepEqual(list.map((job) => [job.sessionId, job.questionId]), [["s1", "q1"], ["s1", "q2"], ["s2", "q1"], ["s2", "q2"]])
  assert.ok(list.every((job) => job.status === "pending" && !Object.hasOwn(job, "answer")))
})

test("approved answers and matching saved suggestions are reused, stale drafts are pending", async () => {
  assert.equal((await buildEssayQueue([question], [session], [{ ...answer, overridden: true, approval_snapshot: snapshot }], []))[0].status, "skipped")
  assert.equal((await buildEssayQueue([question], [session], [answer], [suggestion]))[0].status, "ready")
  for (const stale of [{ ...suggestion, attempt: 2 }, { ...suggestion, answer_snapshot: "old answer" }, { ...suggestion, question_snapshot: { ...snapshot, prompt: "Old prompt" } }, { ...suggestion, approved_at: "yesterday" }]) {
    assert.equal((await buildEssayQueue([question], [session], [answer], [stale]))[0].status, "pending")
  }
})

test("fingerprints ignore object key order but detect rubric, prompt, type, points and checking-rule changes", async () => {
  const hash = await questionGradingFingerprint(question)
  assert.equal(hash.length, 64)
  assert.equal(await questionGradingFingerprint({ ...question, rubric: { criteria: [{ max_points: 10, description: "Explain the concept.", name: "Content", id: "content" }] } }), hash)
  for (const changed of [{ ...question, prompt: "New prompt" }, { ...question, points: 9 }, { ...question, type: "identification" }, { ...question, rubric: { criteria: [{ ...rubric.criteria[0], checking_rule: { mode: "any", concepts: "encryption" } }] } }]) {
    assert.notEqual(await questionGradingFingerprint(changed), hash)
  }
})

test("dispatch is sequential and paced, and completed/skipped jobs never request AI", async () => {
  const r = runner()
  let inFlight = 0
  const request = r.options.request
  r.options.request = async (job) => { assert.equal(inFlight++, 0); await Promise.resolve(); const result = await request(job); inFlight--; return result }
  const input = [...jobs(), { ...jobs()[0], id: "cached", status: "ready" }, { ...jobs()[0], id: "approved", status: "skipped" }]
  const result = await runEssayQueue(input, r.options)
  assert.equal(result.status, "completed")
  assert.deepEqual(r.calls, [{ id: "1", time: 0 }, { id: "2", time: 7000 }, { id: "3", time: 14000 }])
  assert.ok(input.slice(0, 3).every((job) => job.status === "pending"), "does not mutate original jobs")
})

test("pause during an in-flight request saves it, resume starts the next pending item", async () => {
  let paused = false
  const r = runner({ shouldPause: () => paused })
  const request = r.options.request
  r.options.request = async (job) => { const result = await request(job); paused = true; return result }
  const first = await runEssayQueue(jobs(), r.options)
  assert.equal(first.status, "paused")
  assert.equal(first.jobs[0].status, "ready")
  assert.equal(r.calls.length, 1)
  paused = false
  r.options.request = request
  const next = await runEssayQueue(first.jobs, r.options)
  assert.equal(next.status, "completed")
  assert.deepEqual(r.calls.map((call) => call.id), ["1", "2", "3"])
})

test("pause during the pacing delay sends no request; abortable waits stop immediately", async () => {
  let paused = false
  const r = runner({ shouldPause: () => paused, wait: async () => { paused = true } })
  assert.equal((await runEssayQueue(jobs(), r.options)).status, "paused")
  assert.equal(r.calls.length, 0)
  const controller = new AbortController()
  const waiting = waitForEssayQueue(60000, controller.signal)
  controller.abort()
  await waiting
  await waitForEssayQueue(60000, controller.signal)
})

test("authentication and other permanent request errors need manual resumption", async () => {
  for (const status of [400, 401, 403, 404, 415]) {
    let calls = 0
    const r = runner({ request: async () => { calls++; throw Object.assign(new Error("Stop here"), { status }) } })
    const result = await runEssayQueue(jobs(), r.options)
    assert.equal(result.status, "paused")
    assert.equal(result.reason, "Stop here")
    assert.equal(result.jobs[0].status, "pending")
    assert.equal(calls, 1)
  }
})

test("temporary connection, quota and server failures retry the same essay automatically", async () => {
  for (const status of [0, 408, 429, 500, 502, 503, 504]) {
    const r = runner()
    const request = r.options.request
    let failed = false
    r.options.request = async (job) => {
      const result = await request(job)
      if (!failed) { failed = true; throw Object.assign(new Error("Temporary failure"), { status }) }
      return result
    }
    const result = await runEssayQueue(jobs(), r.options)
    const retryAt = status === 429 ? 60000 : 15000
    assert.equal(result.status, "completed")
    assert.deepEqual(r.calls, [{ id: "1", time: 0 }, { id: "1", time: retryAt }, { id: "2", time: retryAt + 7000 }, { id: "3", time: retryAt + 14000 }])
    assert.match(r.updates[1][0].message, /Retrying automatically/)
    assert.ok(result.jobs.every((job) => job.status === "ready"))
  }
})

test("repeated quota failures back off to five minutes and reuse the saved result", async () => {
  const r = runner()
  const request = r.options.request
  let failures = 0
  r.options.request = async (job) => {
    await request(job)
    if (failures++ < 5) throw Object.assign(new Error("Quota busy"), { status: 429 })
    return { cached: true }
  }
  const result = await runEssayQueue(jobs().slice(0, 1), r.options)
  assert.equal(result.status, "completed")
  assert.deepEqual(r.calls.map(({ time }) => time), [0, 60000, 180000, 420000, 720000, 1020000])
  assert.equal(result.jobs[0].message, "Saved suggestion reused")
})

test("manual pause interrupts automatic retry and resume respects the remaining cooldown", async () => {
  let paused = false
  const r = runner({ shouldPause: () => paused })
  const wait = r.options.wait
  r.options.wait = async (ms) => { if (ms > 0) paused = true }
  r.options.request = async () => { throw new TypeError("Browser lost connection") }
  const first = await runEssayQueue(jobs(), r.options)
  assert.equal(first.status, "paused")
  assert.ok(first.jobs.every((job) => job.status === "pending"))
  paused = false
  r.options.wait = wait
  r.options.request = async (job) => { r.calls.push({ id: job.id }); return { cached: true } }
  assert.equal((await runEssayQueue(first.jobs, r.options)).status, "completed")
  assert.deepEqual(r.calls.map(({ id }) => id), ["1", "2", "3"])
  assert.equal(r.options.clock.nextStartAt, 36000)
})

test("waking after a background delay continues pending essays without overlapping or bursts", async () => {
  const r = runner()
  const wait = r.options.wait
  let slept = false
  r.options.wait = async (ms) => { await wait(ms + (slept ? 0 : 120000)); slept = true }
  const result = await runEssayQueue(jobs(), r.options)
  assert.equal(result.status, "completed")
  assert.deepEqual(r.calls.map(({ time }) => time), [120000, 127000, 134000])
})

test("invalid output and stale inputs are isolated while later essays continue", async () => {
  const r = runner({ request: async (job) => {
    if (job.id === "1") throw Object.assign(new Error("Invalid evidence"), { status: 422 })
    if (job.id === "2") throw Object.assign(new Error("Attempt changed"), { status: 409 })
    return { cached: true }
  } })
  const result = await runEssayQueue(jobs(), r.options)
  assert.equal(result.status, "completed")
  assert.deepEqual(result.jobs.map((job) => job.status), ["failed", "skipped", "ready"])
})

function fakeClient(rows, failure) {
  const pages = []
  return { pages, from(table) {
    let ids = []
    const query = {
      select: () => query, in: (field, values) => { if (field === "session_id") ids = values; return query },
      is: () => query, order: (field) => { assert.ok(table !== "answers" || field !== "id", "answers use a composite primary key"); return query },
      range: async (start, end) => { pages.push([table, start, end, ids.length]); return failure ? { error: new Error("Read failed") } : { data: (table === "answers" ? rows : []).slice(start, end + 1) } },
    }
    return query
  } }
}

test("planning paginates beyond 1,000 rows and recognizes drafts/approvals from later pages", async () => {
  const rows = Array.from({ length: 1101 }, (_, index) => ({ ...answer, session_id: `unused${index}` }))
  rows.push({ ...answer, overridden: true, approval_snapshot: snapshot })
  const client = fakeClient(rows)
  const list = await loadEssayQueue(client, [question], [session])
  assert.equal(list[0].status, "skipped")
  assert.deepEqual(client.pages.filter(([table]) => table === "answers").map(([, start]) => start), [0, 500, 1000])
})

test("planning chunks session IDs, surfaces read failures and supports cancellation", async () => {
  const client = fakeClient([])
  await loadEssayQueue(client, [question], Array.from({ length: 51 }, (_, id) => ({ ...session, id: String(id) })))
  assert.deepEqual(client.pages.filter(([table]) => table === "answers").map(([, , , count]) => count), [50, 1])
  await assert.rejects(loadEssayQueue(fakeClient([], true), [question], [session]), /Read failed/)
  await assert.rejects(loadEssayQueue(client, [question], [session], () => true), /stopped/)
})
