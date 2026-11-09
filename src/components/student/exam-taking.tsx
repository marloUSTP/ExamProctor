"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { CheckIcon, Clock3Icon, CloudOffIcon, Loader2Icon, MaximizeIcon, SendIcon, TriangleAlertIcon } from "lucide-react"
import { toast } from "sonner"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Skeleton } from "@/components/ui/skeleton"
import { useExamAnswers } from "@/hooks/use-exam-answers"
import { useProctoring } from "@/hooks/use-proctoring"
import type { AnswerSaveState } from "@/lib/answer-autosave"
import { useOutOfFullscreen } from "@/lib/browser-store"
import { errorMessage } from "@/lib/format"
import { studentApi, type ReportType } from "@/lib/student-api"
import { createServerCountdown, formatCountdown } from "@/lib/schedule"
import { cn } from "@/lib/utils"
import type { BlockedAction, StudentQuestion, StudentState } from "@/lib/types"

const LETTERS = "ABCDEFGHIJ"
const TEXT_SAVE_DELAY_MS = 600

const BLOCKED_MESSAGE: Record<BlockedAction, string> = {
  right_click: "Right-click is disabled during the exam.",
  copy: "Copying is disabled during the exam.",
  cut: "Cutting text is disabled during the exam.",
  paste: "Pasting is disabled during the exam.",
  shortcut: "That shortcut is disabled during the exam.",
}

export function ExamTaking({
  token,
  state,
  onState,
}: {
  token: string
  state: StudentState
  onState: (state: StudentState) => void
}) {
  const { exam, session } = state
  const { questions, answers, saveState, loadError, setAnswer, flush } = useExamAnswers(token, session.started_at)
  const [submitting, setSubmitting] = useState(false)
  const [warning, setWarning] = useState<{ count: number; reason: "left" | "idle" | "screenshot" } | null>(null)
  const [idleOpen, setIdleOpen] = useState(false)
  const [secondsLeft, setSecondsLeft] = useState<number | null>(() =>
    exam.scheduled_end_at ? Math.max(0, Math.floor((Date.parse(exam.scheduled_end_at) - Date.parse(exam.server_now)) / 1000)) : null
  )

  useEffect(() => {
    const countdown = exam.scheduled_end_at ? createServerCountdown(exam.scheduled_end_at, exam.server_now) : () => null
    let refreshed = false
    let cancelled = false
    const update = () => {
      const next = countdown()
      setSecondsLeft(next)
      if (next === 0 && !refreshed) {
        refreshed = true
        studentApi.state(token).then((nextState) => { if (!cancelled) onState(nextState) }).catch(() => {})
      }
    }
    update()
    const interval = window.setInterval(update, 1000)
    document.addEventListener("visibilitychange", update)
    return () => {
      cancelled = true
      window.clearInterval(interval)
      document.removeEventListener("visibilitychange", update)
    }
  }, [exam.scheduled_end_at, exam.server_now, token, onState])

  // ---- Violation warnings: shown whenever the server's count goes up ----
  const lastCount = useRef(session.violation_count)
  const lastReason = useRef<"left" | "idle" | "screenshot">("left")
  useEffect(() => {
    if (session.violation_count > lastCount.current) {
      setWarning({ count: session.violation_count, reason: lastReason.current })
    }
    lastCount.current = session.violation_count
  }, [session.violation_count])

  const report = useCallback(
    (type: ReportType, detail?: string, seconds?: number) => {
      studentApi
        .report(token, type, detail, seconds === undefined ? undefined : Math.round(seconds))
        .then(onState)
        .catch(() => {
          // Offline: the teacher will see this student as "Disconnected" instead.
        })
    },
    [token, onState]
  )

  const lastBlockedToast = useRef(0)

  useProctoring({
    enabled: true,
    idleLimitSeconds: exam.idle_limit_seconds,
    blockCopyPaste: exam.block_copy_paste,
    onLeave: () => {
      lastReason.current = "left"
      void flush() // save typed answers in case this leads to auto-submit
      report("left")
    },
    onReturn: (seconds) => report("returned", undefined, seconds),
    onIdle: () => {
      lastReason.current = "idle"
      setIdleOpen(true)
      report("idle")
    },
    onIdleEnd: (seconds) => {
      setIdleOpen(false)
      report("idle_ended", undefined, seconds)
    },
    onBlocked: (action) => {
      if (Date.now() - lastBlockedToast.current > 2000) {
        lastBlockedToast.current = Date.now()
        toast.warning(BLOCKED_MESSAGE[action])
      }
      report("blocked_action", action)
    },
    onScreenshot: () => {
      lastReason.current = "screenshot"
      report("screenshot_attempt")
    },
  })

  // ---- Fullscreen guard (logged, not a violation) ----
  const outOfFullscreen = useOutOfFullscreen()
  const [fullscreenDismissed, setFullscreenDismissed] = useState(false)
  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement) report("fullscreen_exit")
    }
    document.addEventListener("fullscreenchange", onChange)
    return () => document.removeEventListener("fullscreenchange", onChange)
  }, [report])
  const notFullscreen = outOfFullscreen && !fullscreenDismissed

  async function submit() {
    setSubmitting(true)
    try {
      if (!await flush()) throw new Error("Some answers haven't reached the server yet. Check your connection and try again.")
      const next = await studentApi.submit(token)
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => {})
      onState(next)
    } catch (err) {
      toast.error(errorMessage(err))
      setSubmitting(false)
    }
  }

  const answeredCount = questions ? questions.filter((q) => (answers[q.id] ?? "").trim() !== "").length : 0
  const total = questions?.length ?? exam.question_count
  const remaining = exam.max_violations - (warning?.count ?? session.violation_count)

  return (
    <div className={cn("flex flex-1 flex-col", exam.block_copy_paste && "select-none")}>
      <header className="sticky top-0 z-30 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <div className="truncate font-semibold">{exam.title}</div>
            <div className="text-xs text-muted-foreground">{session.student_name}</div>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {secondsLeft !== null && (
              <Badge variant={secondsLeft <= 60 ? "destructive" : "outline"} className="tabular-nums">
                <Clock3Icon /> {formatCountdown(secondsLeft)}
              </Badge>
            )}
            {questions && <SaveIndicator state={saveState} />}
            <Badge
              variant={session.violation_count >= exam.warn_at ? "destructive" : "outline"}
              className="tabular-nums"
            >
              Violations {session.violation_count}/{exam.max_violations}
            </Badge>
          </div>
        </div>
        <Progress value={total ? (answeredCount / total) * 100 : 0} className="h-1 rounded-none" />
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 space-y-4 px-4 py-6">
        {!questions ? (
          <>
            {loadError && <p role="status" className="text-sm text-destructive">Couldn&apos;t load your questions: {loadError} Retrying automatically…</p>}
            <Skeleton className="h-40" />
            <Skeleton className="h-40" />
          </>
        ) : (
          questions.map((q, i) => (
            <QuestionCard
              key={q.id}
              number={i + 1}
              question={q}
              value={answers[q.id] ?? ""}
              onChange={(v, delay) => setAnswer(q.id, v, delay)}
              disabled={submitting || secondsLeft === 0}
            />
          ))
        )}

        {questions && (
          <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
            <p className="text-sm text-muted-foreground">
              {answeredCount} of {total} answered
            </p>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="lg" disabled={submitting || secondsLeft === 0}>
                  {submitting ? <Loader2Icon className="animate-spin" /> : <SendIcon />}
                  Submit exam
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Submit your exam?</AlertDialogTitle>
                  <AlertDialogDescription>
                    {answeredCount < total
                      ? `You still have ${total - answeredCount} unanswered question${total - answeredCount === 1 ? "" : "s"}. `
                      : "All questions are answered. "}
                    You can&apos;t change your answers after submitting.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Keep answering</AlertDialogCancel>
                  <AlertDialogAction onClick={submit}>Submit</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        )}
      </main>

      {/* Violation warning */}
      <AlertDialog open={!!warning} onOpenChange={(open) => !open && setWarning(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <TriangleAlertIcon className="size-5" />
              {warning && warning.count >= exam.warn_at ? "Final warning" : "Warning"} — {warning?.count}/
              {exam.max_violations}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {warning?.reason === "idle"
                ? "You were inactive for too long. "
                : warning?.reason === "screenshot"
                  ? "A screenshot shortcut was detected. "
                  : "You left the exam window (Alt+Tab, another tab, or another app). "}
              This was recorded and your teacher has been notified.{" "}
              {warning && warning.count >= exam.warn_at ? (
                <strong className="text-foreground">
                  {remaining <= 1
                    ? "One more violation and your exam will be submitted automatically."
                    : `${remaining} more violations and your exam will be submitted automatically.`}
                </strong>
              ) : (
                `After ${exam.max_violations} violations your exam is submitted automatically.`
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setWarning(null)}>I understand</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Idle check */}
      <AlertDialog open={idleOpen && !warning}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you still there?</AlertDialogTitle>
            <AlertDialogDescription>
              You&apos;ve been inactive for {Math.round(exam.idle_limit_seconds / 60)} minute
              {exam.idle_limit_seconds >= 120 ? "s" : ""}. Your teacher has been notified.
              {exam.idle_counts_as_violation && " This counts as a violation."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setIdleOpen(false)}>I&apos;m here</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Fullscreen guard */}
      {notFullscreen && !warning && !idleOpen && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-background/95 p-4 backdrop-blur">
          <div className="max-w-sm space-y-4 text-center">
            <MaximizeIcon className="mx-auto size-8 text-muted-foreground" />
            <h2 className="text-lg font-semibold">Return to fullscreen</h2>
            <p className="text-sm text-muted-foreground">The exam must be taken in fullscreen mode.</p>
            <Button
              size="lg"
              // If the browser refuses fullscreen, let the student continue rather than lock them out.
              onClick={() => document.documentElement.requestFullscreen().catch(() => setFullscreenDismissed(true))}
            >
              Continue exam
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function SaveIndicator({ state: { status, locallySaved } }: { state: AnswerSaveState }) {
  if (status === "saving")
    return (
      <span role="status" className="flex items-center gap-1 text-xs text-muted-foreground">
        <Loader2Icon className="size-3.5 animate-spin" />
        {locallySaved ? "Saved on this device — syncing…" : "Saving to server…"}
      </span>
    )
  if (status === "error")
    return (
      <span role="status" className="flex items-center gap-1 text-xs text-destructive">
        <CloudOffIcon className="size-3.5" />
        {locallySaved ? "Saved on this device — retrying" : "Not saved — retrying"}
      </span>
    )
  return (
    <span role="status" className="flex items-center gap-1 text-xs text-muted-foreground">
      <CheckIcon className="size-3.5" />
      Saved to server
    </span>
  )
}

function QuestionCard({
  number,
  question: q,
  value,
  onChange,
  disabled,
}: {
  number: number
  question: StudentQuestion
  value: string
  onChange: (value: string, delay?: number) => void
  disabled: boolean
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-start justify-between gap-4 text-base font-medium leading-relaxed">
          <span className="whitespace-pre-wrap">
            <span className="mr-1.5 text-muted-foreground">{number}.</span>
            {q.prompt}
          </span>
          <span className="shrink-0 text-xs font-normal text-muted-foreground">
            {q.points} pt{q.points === 1 ? "" : "s"}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {q.type === "multiple_choice" && (
          <RadioGroup value={value} onValueChange={(v) => onChange(v)} disabled={disabled}>
            {/* Shown in this student's shuffled order; the saved value is always the original index. */}
            {(q.choice_order.length ? q.choice_order : q.choices.map((_, i) => i)).map((original, position) => (
              <Label
                key={original}
                htmlFor={`${q.id}-${original}`}
                className={cn(
                  "flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 font-normal transition-colors hover:bg-muted/60",
                  value === String(original) && "border-primary bg-muted/60",
                  disabled && "pointer-events-none opacity-60"
                )}
              >
                <RadioGroupItem value={String(original)} id={`${q.id}-${original}`} />
                <span className="w-4 font-medium text-muted-foreground">{LETTERS[position]}</span>
                <span>{q.choices[original]}</span>
              </Label>
            ))}
          </RadioGroup>
        )}

        {q.type === "true_false" && (
          <RadioGroup value={value} onValueChange={(v) => onChange(v)} className="grid-cols-2" disabled={disabled}>
            {["true", "false"].map((v) => (
              <Label
                key={v}
                htmlFor={`${q.id}-${v}`}
                className={cn(
                  "flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 font-normal transition-colors hover:bg-muted/60",
                  value === v && "border-primary bg-muted/60",
                  disabled && "pointer-events-none opacity-60"
                )}
              >
                <RadioGroupItem value={v} id={`${q.id}-${v}`} />
                {v === "true" ? "True" : "False"}
              </Label>
            ))}
          </RadioGroup>
        )}

        {q.type === "identification" && (
          <Input
            value={value}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value, TEXT_SAVE_DELAY_MS)}
            placeholder="Type your answer"
            maxLength={2000}
            autoComplete="off"
            spellCheck={false}
            className="select-text"
          />
        )}

        {q.type === "essay" && (
          <Textarea
            value={value}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value, TEXT_SAVE_DELAY_MS)}
            placeholder="Type your answer here…"
            rows={5}
            maxLength={5000}
            autoComplete="off"
            spellCheck={true}
            className="select-text resize-y"
          />
        )}
      </CardContent>
    </Card>
  )
}
