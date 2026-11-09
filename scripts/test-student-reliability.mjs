import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import ts from "typescript"

async function loadHelpers(path) {
  const { outputText } = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2017 } })
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`)
}

const { AnswerAutosave, createAnswerDraftStore, clearAnswerDraft } = await loadHelpers("src/lib/answer-autosave.ts")
const { createServerCountdown } = await loadHelpers("src/lib/schedule.ts")
const startedAt = "2026-10-15T01:00:00Z"
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }

function memoryStorage() {
  const values = new Map()
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  }
}

function fixture(t, save = async () => {}, storage = memoryStorage(), token = "test-session", attempt = startedAt) {
  const states = []
  const drafts = createAnswerDraftStore(token, attempt, () => storage)
  const saver = new AnswerAutosave(save, drafts, (state) => states.push(state))
  t.after(() => saver.dispose())
  return { saver, drafts, storage, states }
}

test("countdown ticks every second without waiting for the next four-second server poll", () => {
  let elapsed = 0
  const countdown = createServerCountdown("2026-10-15T01:00:10Z", startedAt, () => elapsed)
  assert.equal(countdown(), 10)
  for (const seconds of [1, 2, 3, 4]) {
    elapsed = seconds * 1000
    assert.equal(countdown(), 10 - seconds)
  }
})

test("countdown catches up after delayed ticks, ignores the device clock, resyncs and clamps at zero", (t) => {
  t.mock.method(Date, "now", () => Date.parse("2030-01-01T00:00:00Z"))
  let elapsed = 123456
  const countdown = createServerCountdown("2026-10-15T01:00:10Z", startedAt, () => elapsed)
  elapsed += 7250
  assert.equal(countdown(), 2)
  const corrected = createServerCountdown("2026-10-15T01:00:10Z", "2026-10-15T01:00:08Z", () => elapsed)
  assert.equal(corrected(), 2)
  elapsed += 3000
  assert.equal(corrected(), 0)
  assert.equal(countdown(), 0)
})

test("reload restores debounced edits and cleared answers before retrying the server", async (t) => {
  const first = fixture(t)
  first.saver.restore({ essay: "Old essay", identification: "Old answer" })
  first.saver.setAnswer("essay", "Unsaved essay", 60000)
  first.saver.setAnswer("identification", "", 60000)
  assert.deepEqual(first.drafts.read(), { essay: "Unsaved essay", identification: "" })
  first.saver.dispose()

  const saved = []
  const reopened = fixture(t, async (id, value) => { saved.push([id, value]) }, first.storage)
  assert.deepEqual(reopened.saver.restore({ essay: "Old essay", identification: "Old answer" }), { essay: "Unsaved essay", identification: "" })
  assert.equal(await reopened.saver.flush(), true)
  assert.deepEqual(saved, [["essay", "Unsaved essay"], ["identification", ""]])
  assert.equal(first.storage.values.size, 0)
  assert.equal(reopened.states.at(-1).status, "saved")
})

test("an in-flight answer remains recoverable if the page closes before acknowledgement", async (t) => {
  const request = deferred()
  const first = fixture(t, () => request.promise)
  first.saver.setAnswer("essay", "In-flight essay", 60000)
  const saving = first.saver.flush()
  assert.deepEqual(first.drafts.read(), { essay: "In-flight essay" })
  first.saver.dispose()
  request.resolve()
  assert.equal(await saving, false)
  assert.deepEqual(first.drafts.read(), { essay: "In-flight essay" })
  const reopened = fixture(t, undefined, first.storage)
  assert.deepEqual(reopened.saver.restore({ essay: "" }), { essay: "In-flight essay" })
})

test("an older acknowledgement cannot delete newer edits, including A to B to A", async (t) => {
  const requests = []
  const { saver, drafts } = fixture(t, (id, value) => {
    const request = deferred()
    requests.push({ id, value, ...request })
    return request.promise
  })
  saver.setAnswer("essay", "A", 60000)
  const saving = saver.flush()
  saver.setAnswer("essay", "B", 60000)
  saver.setAnswer("essay", "A", 60000)
  requests[0].resolve()
  await settle()
  assert.deepEqual(drafts.read(), { essay: "A" })
  assert.equal(requests.length, 2)
  requests[1].resolve()
  assert.equal(await saving, true)
  assert.deepEqual(drafts.read(), {})
})

test("partial failures wait for all in-flight saves and retry only the latest pending values", async (t) => {
  const slow = deferred()
  const calls = []
  let offline = true
  const { saver, drafts } = fixture(t, (id, value) => {
    calls.push([id, value])
    if (offline && id === "q1") return Promise.reject(new Error("offline"))
    if (offline && id === "q2") return slow.promise
    return Promise.resolve()
  })
  saver.setAnswer("q1", "one", 60000)
  saver.setAnswer("q2", "old", 60000)
  const saving = saver.flush()
  saver.setAnswer("q2", "new", 60000)
  assert.equal(saver.flush(), saving)
  await settle()
  assert.equal(calls.length, 2, "no overlapping retry while the old request is unfinished")
  slow.resolve()
  assert.equal(await saving, false, "submission must wait when any answer failed")
  assert.deepEqual(drafts.read(), { q1: "one", q2: "new" })
  offline = false
  assert.equal(await saver.flush(), true)
  assert.deepEqual(calls, [["q1", "one"], ["q2", "old"], ["q1", "one"], ["q2", "new"]])
})

test("network failures retry automatically and keep a truthful local save status", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let offline = true
  let calls = 0
  const { saver, states } = fixture(t, async () => { calls++; if (offline) throw new Error("offline") })
  saver.setAnswer("essay", "Draft", 600)
  assert.deepEqual(states.at(-1), { status: "saving", locallySaved: true })
  t.mock.timers.tick(600)
  await settle()
  assert.deepEqual(states.at(-1), { status: "error", locallySaved: true })
  offline = false
  t.mock.timers.tick(3000)
  await settle()
  assert.equal(calls, 2)
  assert.equal(states.at(-1).status, "saved")
})

test("unavailable browser storage does not claim local recovery or block server saving", async (t) => {
  const blockedStorage = () => { throw new Error("Storage is blocked") }
  const storage = { getItem: blockedStorage, setItem: blockedStorage, removeItem: blockedStorage }
  const { saver, states } = fixture(t, undefined, storage)
  assert.deepEqual(saver.restore({ essay: "Server answer" }), { essay: "Server answer" })
  saver.setAnswer("essay", "New answer", 60000)
  assert.deepEqual(states.at(-1), { status: "saving", locallySaved: false })
  assert.equal(await saver.flush(), true)
  assert.equal(states.at(-1).status, "saved")
})

test("drafts cannot cross sessions or exam attempts", (t) => {
  const first = fixture(t)
  first.saver.setAnswer("essay", "Previous attempt", 60000)
  const otherStudent = createAnswerDraftStore("different-session", startedAt, () => first.storage)
  assert.deepEqual(otherStudent.read(), {})
  const retake = fixture(t, undefined, first.storage, "test-session", "2026-10-15T02:00:00Z")
  assert.deepEqual(retake.saver.restore({ essay: "" }), { essay: "" })
  assert.equal(first.storage.values.size, 0)
})

test("already saved answers and removed questions are discarded rather than replayed", async (t) => {
  const { saver, drafts } = fixture(t, async () => { assert.fail("nothing should be replayed") })
  drafts.write({ essay: "Already saved", removedQuestion: "Obsolete" })
  assert.deepEqual(saver.restore({ essay: "Already saved" }), { essay: "Already saved" })
  assert.equal(await saver.flush(), true)
  assert.deepEqual(drafts.read(), {})
})

test("corrupt or invalid draft data does not prevent loading the exam", (t) => {
  const { storage, drafts } = fixture(t)
  for (const raw of ["invalid JSON", "null", JSON.stringify({ version: 1, startedAt, answers: [] })]) {
    storage.setItem("exam-proctor:draft:test-session", raw)
    assert.deepEqual(drafts.read(), {})
  }
})

test("confirmed completion clears drafts and disposed requests cannot recreate them", async (t) => {
  const request = deferred()
  const { saver, storage } = fixture(t, () => request.promise)
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: storage } })
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow)
    else delete globalThis.window
  })
  saver.setAnswer("essay", "Final answer", 60000)
  const saving = saver.flush()
  saver.dispose()
  clearAnswerDraft("test-session")
  request.resolve()
  await saving
  assert.equal(storage.values.size, 0)
})
