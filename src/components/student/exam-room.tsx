"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useCallback, useEffect, useState } from "react"
import {
  BanIcon,
  HourglassIcon,
  Loader2Icon,
  LogOutIcon,
  MaximizeIcon,
  MoonIcon,
  SmartphoneIcon,
  ShieldAlertIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { ExamTaking } from "@/components/student/exam-taking"
import { ResultScreen } from "@/components/student/result-screen"
import { useBrowserValue } from "@/lib/browser-store"
import { clearAnswerDraft } from "@/lib/answer-autosave"
import { errorMessage } from "@/lib/format"
import { studentApi, studentToken } from "@/lib/student-api"
import { formatScheduleDate } from "@/lib/schedule"
import type { StudentState } from "@/lib/types"

const POLL_MS = { waiting: 3000, taking: 4000, done: 10000 }

function CenteredCard({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-16">
      <Card className="w-full max-w-lg">{children}</Card>
    </main>
  )
}

export function ExamRoom({ code }: { code: string }) {
  const router = useRouter()
  // undefined while server-rendering, null when this device never joined the exam.
  const token = useBrowserValue(() => studentToken.get(code), undefined)
  const [state, setState] = useState<StudentState | null>(null)
  const [fatal, setFatal] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [touchMobile, setTouchMobile] = useState(false)

  useEffect(() => {
    const query = window.matchMedia("(pointer: coarse) and (max-width: 768px)")
    const update = () => setTouchMobile(query.matches)
    update()
    query.addEventListener("change", update)
    return () => query.removeEventListener("change", update)
  }, [])

  useEffect(() => {
    if (token === null && !fatal) router.replace(`/join?code=${code}`)
  }, [token, fatal, code, router])

  const refresh = useCallback(async () => {
    if (!token) return
    try {
      setState(await studentApi.state(token))
    } catch (err) {
      const message = (err as { message?: string })?.message
      if (message === "INVALID_TOKEN") {
        // The teacher removed this student; let them join again.
        clearAnswerDraft(token)
        studentToken.clear(code)
        setFatal("Your entry for this exam was removed by your teacher. You can ask to join again.")
      }
      // Network blips are ignored — the next poll will retry.
    }
  }, [token, code])

  const status = state?.session.status
  const phase = !status
    ? "waiting"
    : status === "in_progress"
      ? "taking"
      : status === "submitted" || status === "auto_submitted"
        ? "done"
        : "waiting"

  useEffect(() => {
    if (token && (status === "submitted" || status === "auto_submitted")) clearAnswerDraft(token)
  }, [token, status])

  // Poll: approval, teacher setting changes, and the heartbeat that keeps "Disconnected" away.
  useEffect(() => {
    if (!token || fatal) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- polling the server; state is set after the request returns
    void refresh()
    const t = window.setInterval(refresh, POLL_MS[phase])
    return () => window.clearInterval(t)
  }, [token, fatal, phase, refresh])

  async function start() {
    if (!token) return
    setStarting(true)
    // Fullscreen must be requested directly from the click.
    try {
      if (document.fullscreenEnabled && !document.fullscreenElement) {
        await document.documentElement.requestFullscreen()
      }
    } catch {
      // Some browsers (e.g. iPhone Safari) don't support it — the exam still works.
    }
    try {
      setState(await studentApi.start(token))
    } catch (err) {
      setFatal(errorMessage(err))
    } finally {
      setStarting(false)
    }
  }

  if (fatal) {
    return (
      <CenteredCard>
        <CardHeader>
          <CardTitle>Can&apos;t continue</CardTitle>
          <CardDescription>{fatal}</CardDescription>
        </CardHeader>
        <CardFooter>
          <Button asChild>
            <Link href={`/join?code=${code}`}>Back to join page</Link>
          </Button>
        </CardFooter>
      </CenteredCard>
    )
  }

  if (!state || !token) {
    return (
      <main className="flex flex-1 items-center justify-center">
        <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
      </main>
    )
  }

  const { session, exam } = state
  const now = Date.parse(exam.server_now)
  const scheduled = !!exam.scheduled_start_at && !!exam.scheduled_end_at
  const beforeStart = scheduled && now < Date.parse(exam.scheduled_start_at!)
  const beforeDeadline = !scheduled || now < Date.parse(exam.scheduled_end_at!)

  if (session.status === "in_progress") {
    return <ExamTaking key={`${token}:${session.started_at}`} token={token} state={state} onState={setState} />
  }

  if (session.status === "submitted" || session.status === "auto_submitted") {
    return <ResultScreen state={state} />
  }

  if (exam.status === "closed" || (scheduled && !beforeDeadline)) {
    return (
      <CenteredCard>
        <CardHeader>
          <CardTitle>{exam.title}</CardTitle>
          <CardDescription>{exam.status === "closed" ? "This exam has been closed by your teacher." : "The scheduled exam window has ended."}</CardDescription>
        </CardHeader>
      </CenteredCard>
    )
  }

  if (session.status === "rejected") {
    return (
      <CenteredCard>
        <CardHeader>
          <BanIcon className="mb-2 size-6 text-destructive" />
          <CardTitle>Request not approved</CardTitle>
          <CardDescription>
            Your teacher did not approve {session.student_email} for “{exam.title}”. If this is a mistake, tell your teacher —
            they can still approve you, and this page will update by itself.
          </CardDescription>
        </CardHeader>
      </CenteredCard>
    )
  }

  if (session.status === "pending") {
    return (
      <CenteredCard>
        <CardHeader>
          <HourglassIcon className="mb-2 size-6 text-muted-foreground" />
          <CardTitle>Waiting for your teacher</CardTitle>
          <CardDescription>
            You asked to join <strong className="text-foreground">{exam.title}</strong> as {session.student_name} (
            {session.student_email}). Keep this page open — it will continue automatically once you&apos;re approved.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2Icon className="size-4 animate-spin" />
          Checking for approval…
        </CardContent>
      </CenteredCard>
    )
  }

  // Approved — show the rules before starting.
  const idleMinutes = Math.round(exam.idle_limit_seconds / 60)
  return (
    <CenteredCard>
      <CardHeader>
        <CardTitle className="text-xl">{exam.title}</CardTitle>
        <CardDescription>
          You&apos;re approved, {session.student_name}. {exam.question_count} question{exam.question_count === 1 ? "" : "s"}.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {exam.instructions && <p className="whitespace-pre-wrap text-sm">{exam.instructions}</p>}
        {scheduled && (
          <div className="rounded-lg border bg-muted/40 p-4 text-sm">
            <p><strong>Starts:</strong> {formatScheduleDate(exam.scheduled_start_at!)}</p>
            <p className="mt-1"><strong>Shared deadline:</strong> {formatScheduleDate(exam.scheduled_end_at!)}</p>
            {beforeStart && <p className="mt-2 text-muted-foreground">You can start when the scheduled window opens. Keep this page open.</p>}
          </div>
        )}
        {touchMobile && (
          <div className="flex gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
            <SmartphoneIcon className="mt-0.5 size-5 shrink-0 text-amber-700 dark:text-amber-400" />
            <div className="space-y-1">
              <p className="font-medium">Mobile device reminder</p>
              <p className="text-muted-foreground">
                Keep this exam page open. Switching to another app, locking your screen, or leaving the browser may be
                reported as a violation. Your exam can be submitted automatically when you reach the violation limit.
                Answers save as you go while you&apos;re connected.
              </p>
            </div>
          </div>
        )}
        <div className="space-y-3 rounded-lg border bg-muted/40 p-4 text-sm">
          <div className="flex items-center gap-2 font-medium">
            <ShieldAlertIcon className="size-4" />
            Exam rules
          </div>
          <ul className="space-y-2.5 text-muted-foreground">
            <li className="flex gap-2">
              <LogOutIcon className="mt-0.5 size-4 shrink-0" />
              <span>
                Don&apos;t leave this page — no Alt+Tab, switching tabs, minimizing, or refreshing. Each time counts as a
                violation and your teacher is notified. After{" "}
                <strong className="text-foreground">{exam.max_violations} violations</strong> your exam is submitted
                automatically.
              </span>
            </li>
            <li className="flex gap-2">
              <MoonIcon className="mt-0.5 size-4 shrink-0" />
              <span>
                If you&apos;re inactive for {idleMinutes} minute{idleMinutes === 1 ? "" : "s"}, your teacher is notified
                {exam.idle_counts_as_violation ? " and it counts as a violation" : ""}.
              </span>
            </li>
            {exam.block_copy_paste && (
              <li className="flex gap-2">
                <BanIcon className="mt-0.5 size-4 shrink-0" />
                <span>Right-click, copy and paste are disabled.</span>
              </li>
            )}
            <li className="flex gap-2">
              <BanIcon className="mt-0.5 size-4 shrink-0" />
              <span>Screenshot keyboard shortcuts detected by the browser count as violations. Phone screenshot buttons and some operating-system capture tools cannot be detected by a website.</span>
            </li>
            <li className="flex gap-2">
              <MaximizeIcon className="mt-0.5 size-4 shrink-0" />
              <span>The exam opens in fullscreen. Your answers save automatically.</span>
            </li>
          </ul>
        </div>
      </CardContent>
      <CardFooter>
        <Button size="lg" className="w-full" onClick={start} disabled={starting || (!scheduled && exam.status !== "open") || beforeStart || !beforeDeadline}>
          {starting && <Loader2Icon className="animate-spin" />}
          {beforeStart ? "Waiting for scheduled start…" : "Start exam"}
        </Button>
      </CardFooter>
    </CenteredCard>
  )
}
