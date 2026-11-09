export type AnswerSaveState = {
  status: "saved" | "saving" | "error"
  locallySaved: boolean
}

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">
const draftKey = (token: string) => `exam-proctor:draft:${token}`

/** One draft per session; startedAt prevents a retake from restoring the previous attempt. */
export function createAnswerDraftStore(
  token: string,
  startedAt: string | null,
  storage: () => DraftStorage = () => window.localStorage
) {
  const key = draftKey(token)
  return {
    read(): Record<string, string> {
      try {
        const raw = storage().getItem(key)
        if (!raw) return {}
        const draft = JSON.parse(raw)
        if (draft?.version !== 1 || draft.startedAt !== startedAt || !draft.answers || typeof draft.answers !== "object" || Array.isArray(draft.answers)) {
          storage().removeItem(key)
          return {}
        }
        return Object.fromEntries(Object.entries(draft.answers).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      } catch {
        return {}
      }
    },
    write(answers: Record<string, string>): boolean {
      try {
        if (Object.keys(answers).length) {
          storage().setItem(key, JSON.stringify({ version: 1, startedAt, answers }))
        } else {
          storage().removeItem(key)
        }
        return true
      } catch {
        // Storage can be blocked or full. Server saving must still work.
        return false
      }
    },
  }
}

export function clearAnswerDraft(token: string) {
  try {
    window.localStorage.removeItem(draftKey(token))
  } catch {}
}

type DraftStore = ReturnType<typeof createAnswerDraftStore>
type PendingAnswer = { value: string }

/** Keeps in-flight answers durable and sends each question's edits in order. */
export class AnswerAutosave {
  private pending = new Map<string, PendingAnswer>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private flushing: Promise<boolean> | null = null
  private stopped = false
  private locallySaved = false

  constructor(
    private save: (questionId: string, value: string) => Promise<unknown>,
    private drafts: DraftStore,
    private onState: (state: AnswerSaveState) => void
  ) {}

  restore(serverAnswers: Record<string, string>): Record<string, string> {
    const answers = { ...serverAnswers }
    for (const [id, value] of Object.entries(this.drafts.read())) {
      // Ignore removed questions and drafts already acknowledged by the server.
      if (Object.hasOwn(serverAnswers, id) && value !== serverAnswers[id]) {
        this.pending.set(id, { value })
        answers[id] = value
      }
    }
    this.persist()
    this.publish(this.pending.size ? "saving" : "saved")
    return answers
  }

  setAnswer(id: string, value: string, delay = 0) {
    if (this.stopped) return
    this.pending.set(id, { value })
    // Persist synchronously, before the debounce or any network request.
    this.persist()
    this.publish("saving")
    this.schedule(delay)
  }

  flush(): Promise<boolean> {
    clearTimeout(this.timer)
    if (this.stopped) return Promise.resolve(false)
    if (this.flushing) return this.flushing
    this.flushing = this.drain().finally(() => { this.flushing = null })
    return this.flushing
  }

  dispose() {
    this.stopped = true
    clearTimeout(this.timer)
    // Preserve drafts on unmount; only a confirmed finished session clears them.
  }

  private schedule(delay: number) {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.flush(), delay)
  }

  private persist() {
    this.locallySaved = this.drafts.write(Object.fromEntries([...this.pending].map(([id, answer]) => [id, answer.value])))
  }

  private publish(status: AnswerSaveState["status"]) {
    this.onState({ status, locallySaved: this.locallySaved })
  }

  private async drain(): Promise<boolean> {
    while (this.pending.size && !this.stopped) {
      this.publish("saving")
      const batch = [...this.pending]
      // Wait for every request before retrying, so an older save cannot finish after a newer one.
      const results = await Promise.allSettled(batch.map(async ([id, answer]) => this.save(id, answer.value)))
      if (this.stopped) return false
      results.forEach((result, index) => {
        const [id, answer] = batch[index]
        // Object identity also protects edits that change A -> B -> A during a save.
        if (result.status === "fulfilled" && this.pending.get(id) === answer) this.pending.delete(id)
      })
      this.persist()
      if (results.some((result) => result.status === "rejected")) {
        this.publish("error")
        this.schedule(3000)
        return false
      }
    }
    if (this.stopped) return false
    this.publish("saved")
    return true
  }
}
