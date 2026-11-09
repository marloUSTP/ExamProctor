"use client"

import { useEffect, useRef, useState } from "react"
import { Loader2Icon, PauseIcon, PlayIcon, SparklesIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { createClient } from "@/lib/supabase/client"
import { loadEssayQueue } from "@/lib/essay-queue-client"
import { queueableEssayQuestions, runEssayQueue, waitForEssayQueue, type EssayQueueJob } from "@/lib/essay-queue"
import { requestTeacherAi } from "@/lib/teacher-ai-client"
import { errorMessage } from "@/lib/format"
import type { ExamSession, Question } from "@/lib/types"

const defaultServices = {
  prepare: (questions: Question[], sessions: ExamSession[], cancelled: () => boolean) => loadEssayQueue(createClient(), questions, sessions, cancelled),
  request: (job: EssayQueueJob) => requestTeacherAi({ action: "grade-essay", sessionId: job.sessionId, questionId: job.questionId,
    expectedAttempt: job.attempt, expectedQuestionFingerprint: job.fingerprint }),
}

export function EssaySuggestionQueue({ questions, sessions, onReview, onActiveChange, disabled = false, services = defaultServices }: {
  questions: Question[]; sessions: ExamSession[]; onReview: (sessionId: string) => void; onActiveChange: (active: boolean) => void
  services?: typeof defaultServices
  disabled?: boolean
}) {
  const eligible = queueableEssayQuestions(questions)
  const [selected, setSelected] = useState<string[]>(() => eligible.map((question) => question.id))
  const [jobs, setJobs] = useState<EssayQueueJob[] | null>(null)
  const [phase, setPhase] = useState<"idle" | "preparing" | "running" | "paused" | "completed">("idle")
  const [message, setMessage] = useState("")
  const [pausing, setPausing] = useState(false)
  const mounted = useRef(false)
  const locked = useRef(false)
  const pause = useRef(false)
  const delay = useRef<AbortController | null>(null)
  const clock = useRef({ nextStartAt: 0 })
  const active = phase === "running"
  const processing = active || phase === "preparing"
  const busy = processing || disabled

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; pause.current = true; delay.current?.abort() }
  }, [])
  useEffect(() => { onActiveChange(processing); return () => onActiveChange(false) }, [processing, onActiveChange])

  async function prepare() {
    if (locked.current || disabled) return
    locked.current = true
    pause.current = false
    setPhase("preparing"); setMessage("")
    try {
      const list = await services.prepare(questions.filter((question) => selected.includes(question.id)), sessions, () => !mounted.current)
      if (mounted.current) {
        setJobs(list)
        await execute(list)
      }
    } catch (error) {
      if (mounted.current) { setMessage(errorMessage(error)); setPhase(jobs ? "paused" : "idle") }
    } finally { locked.current = false }
  }

  async function start() {
    if (locked.current || disabled || !jobs) return
    locked.current = true
    try { await execute(jobs) } finally { locked.current = false }
  }

  async function execute(list: EssayQueueJob[]) {
    pause.current = false
    delay.current = new AbortController()
    setPhase("running"); setPausing(false); setMessage("")
    try {
      const result = await runEssayQueue(list, {
        clock: clock.current,
        shouldPause: () => pause.current || !mounted.current,
        wait: (ms) => waitForEssayQueue(ms, delay.current!.signal),
        update: (list) => { if (mounted.current) setJobs(list) },
        request: services.request,
      })
      if (mounted.current) {
        setJobs(result.jobs); setPhase(result.status); setPausing(false)
        setMessage(result.reason ?? (result.status === "paused" ? "Paused. Saved suggestions are ready for your review." : "Queue finished. Review and approve each student's rubric scores."))
      }
    } catch (error) {
      if (mounted.current) { setPhase("paused"); setPausing(false); setMessage(errorMessage(error)) }
    }
  }

  function stop() { pause.current = true; delay.current?.abort(); setPausing(true) }
  function select(ids: string[]) { setSelected(ids); setJobs(null); setPhase("idle"); setMessage("") }
  const count = (status: EssayQueueJob["status"]) => jobs?.filter((job) => job.status === status).length ?? 0
  const pending = count("pending")
  const done = count("ready") + count("skipped") + count("failed")
  const current = jobs?.find((job) => job.status === "working")
  const retrying = jobs?.find((job) => job.status === "pending" && job.message)
  const students = [...new Map(jobs?.filter((job) => job.status === "ready").map((job) => [job.sessionId, job.studentName])).entries()]
  const issues = jobs?.filter((job) => job.status === "failed" || (job.status === "skipped" && job.message !== "Already teacher approved")) ?? []

  if (!questions.some((question) => question.type === "essay")) return null
  return <Card>
    <CardHeader>
      <CardTitle>Essay suggestions</CardTitle>
      <CardDescription>Check submitted essays individually against their rubrics. Every score still needs your approval.</CardDescription>
    </CardHeader>
    <CardContent className="space-y-4">
      <fieldset disabled={busy} className="space-y-2">
        <legend className="mb-2 text-sm font-medium">Essay questions</legend>
        <div className="flex gap-3 text-xs">
          <button type="button" className="underline disabled:opacity-50" disabled={busy} onClick={() => select(eligible.map((question) => question.id))}>Select all eligible</button>
          <button type="button" className="underline disabled:opacity-50" disabled={busy} onClick={() => select([])}>Clear selection</button>
        </div>
        <div className="max-h-40 space-y-2 overflow-y-auto rounded-md border p-3">
          {questions.filter((question) => question.type === "essay").map((question) => {
            const enabled = eligible.some((item) => item.id === question.id)
            return <label key={question.id} className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1 size-4 shrink-0 accent-primary" disabled={!enabled} checked={enabled && selected.includes(question.id)}
                onChange={(event) => select(event.target.checked ? [...selected, question.id] : selected.filter((id) => id !== question.id))} />
              <span>Q{question.position + 1}. {question.prompt}{!enabled && <span className="block text-xs text-muted-foreground">Save a valid rubric whose total equals the question points to include this essay.</span>}</span>
            </label>
          })}
        </div>
      </fieldset>
      <p className="text-xs text-muted-foreground">Generate once to start automatically. You can switch browser windows or workspace tabs while it runs. Keep this exam page open; browser sleep can delay requests, which continue when the page wakes. Saved suggestions remain if you close the page.</p>
      <p className="text-xs text-muted-foreground">Each pending essay uses your configured Gemini/Groq allowance. Requests run one at a time, spaced at least 7 seconds apart. Temporary connection, quota and server errors retry automatically with increasing delays, up to 5 minutes. Sign-in or permission errors need your attention. AI can misread a rubric; review the evidence before approving.</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={busy || !eligible.some((question) => selected.includes(question.id)) || !sessions.some((session) => ["submitted", "auto_submitted"].includes(session.status))} onClick={() => void prepare()}>
          {phase === "preparing" ? <Loader2Icon className="animate-spin" /> : <SparklesIcon />}
          {phase === "preparing" ? "Preparing pending essays…" : jobs ? "Refresh and generate suggestions" : "Generate pending essay suggestions"}
        </Button>
        {jobs && !active && pending > 0 && <Button onClick={() => void start()} disabled={busy}>
          <PlayIcon />{phase === "paused" ? "Resume" : "Start"} {pending} suggestion{pending === 1 ? "" : "s"}
        </Button>}
        {active && <Button variant="outline" disabled={pausing} onClick={stop}><PauseIcon />{pausing ? "Pausing after current request…" : "Pause"}</Button>}
      </div>
      {jobs && <div className="space-y-2 rounded-md border p-3">
        <p className="text-sm font-medium">{jobs.length} essay answers · {count("ready")} suggestions ready · {count("skipped")} skipped · {count("failed")} failed · {pending} pending</p>
        <progress aria-label="Essay suggestion progress" className="h-2 w-full accent-primary" value={done} max={Math.max(1, jobs.length)} />
        <p className="text-xs text-muted-foreground">Approved answers and matching saved suggestions are skipped. Scores still need your approval.</p>
        <p role="status" className="text-sm">{current ? `Checking ${current.studentName} · ${current.questionLabel}` : active ? retrying?.message ?? "Waiting before the next essay…" : message || (pending ? "Ready to start. No scores have been approved." : jobs.length ? "No pending essays in this selection." : "No submitted essays in this selection.")}</p>
      </div>}
      {!jobs && message && <p role="alert" className="text-sm text-destructive">{message}</p>}
      {issues.length > 0 && <details className="text-sm"><summary className="cursor-pointer">{issues.length} item{issues.length === 1 ? " needs" : "s need"} attention</summary>
        <ul className="mt-2 max-h-48 space-y-2 overflow-y-auto">{issues.map((job) => <li key={job.id}><span className="font-medium">{job.studentName} · {job.questionLabel}</span><p className="text-xs text-muted-foreground">{job.message}</p></li>)}</ul>
      </details>}
      {students.length > 0 && <details open={!active} className="text-sm"><summary className="cursor-pointer">Review saved suggestions ({students.length} student{students.length === 1 ? "" : "s"})</summary>
        <div className="mt-2 flex max-h-48 flex-wrap gap-2 overflow-y-auto">{students.map(([id, name]) => <Button key={id} size="sm" variant="outline" disabled={busy} onClick={() => onReview(id)}>Review {name}</Button>)}</div>
        {active && <p className="mt-2 text-xs text-muted-foreground">Pause the queue to review completed suggestions.</p>}
      </details>}
    </CardContent>
  </Card>
}
