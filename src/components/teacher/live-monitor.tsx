"use client"

import { useEffect, useMemo, useState } from "react"
import {
  BellIcon,
  CheckIcon,
  MinusCircleIcon,
  MoreHorizontalIcon,
  RotateCcwIcon,
  UsersIcon,
  Volume2Icon,
  XIcon,
} from "lucide-react"
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
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import { TeacherLoading } from "@/components/teacher/loading-skeleton"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { DeductPointsDialog } from "@/components/teacher/deduct-points-dialog"
import { EventIcon } from "@/components/teacher/event-icon"
import type { AlertPrefs, ConnectionStatus, useExamLive } from "@/hooks/use-exam-live"
import { createClient } from "@/lib/supabase/client"
import {
  describeEvent,
  errorMessage,
  formatDuration,
  formatTime,
  LIVE_STATUS_META,
  liveStatus,
  type LiveStatus,
} from "@/lib/format"
import { cn } from "@/lib/utils"
import type { Exam, ExamSession, SessionEvent } from "@/lib/types"

type Live = ReturnType<typeof useExamLive>

// Students who need attention float to the top.
const STATUS_ORDER: LiveStatus[] = [
  "away",
  "idle",
  "disconnected",
  "active",
  "approved",
  "auto_submitted",
  "submitted",
  "rejected",
  "pending",
]

export function LiveMonitor({
  exam,
  live,
  prefs,
  onPrefsChange,
}: {
  exam: Exam
  live: Live
  prefs: AlertPrefs
  onPrefsChange: (prefs: AlertPrefs) => void
}) {
  const [now, setNow] = useState(() => Date.now())
  const [timelineFor, setTimelineFor] = useState<ExamSession | null>(null)
  const [removing, setRemoving] = useState<ExamSession | null>(null)
  const [retaking, setRetaking] = useState<ExamSession | null>(null)
  const [deducting, setDeducting] = useState<ExamSession | null>(null)

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 2000)
    return () => window.clearInterval(t)
  }, [])

  const pending = live.sessions.filter((s) => s.status === "pending")
  const students = useMemo(
    () =>
      live.sessions
        .filter((s) => s.status !== "pending")
        .map((s) => ({ session: s, status: liveStatus(s, now) }))
        .sort(
          (a, b) =>
            STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
            a.session.student_name.localeCompare(b.session.student_name)
        ),
    [live.sessions, now]
  )

  const namesById = useMemo(() => new Map(live.sessions.map((s) => [s.id, s.student_name])), [live.sessions])

  async function enableDesktop(on: boolean) {
    if (on && "Notification" in window && Notification.permission !== "granted") {
      const result = await Notification.requestPermission()
      if (result !== "granted") {
        toast.error("Your browser blocked notifications for this site.")
        return
      }
    }
    onPrefsChange({ ...prefs, desktop: on })
  }

  async function approveAll() {
    const { data, error } = await createClient().rpc("teacher_approve_all", { p_exam_id: exam.id })
    if (error) return toast.error(errorMessage(error))
    pending.forEach((s) => toast.dismiss(`join-${s.id}`))
    toast.success(`Approved ${data} student${data === 1 ? "" : "s"}`)
    await live.refresh()
  }

  async function forceSubmit(session: ExamSession) {
    const { error } = await createClient().rpc("teacher_force_submit", { p_session_id: session.id })
    if (error) return toast.error(errorMessage(error))
    await live.refresh()
  }

  async function allowRetake(session: ExamSession) {
    const { error } = await createClient().rpc("teacher_allow_retake", { p_session_id: session.id })
    if (error) return toast.error(errorMessage(error))
    toast.success(`${session.student_name} can retake the exam`, {
      description: "Their exam page switches back to “Start exam” within a few seconds.",
    })
    await live.refresh()
  }

  async function remove(session: ExamSession) {
    const { error } = await createClient().from("exam_sessions").delete().eq("id", session.id)
    if (error) return toast.error(errorMessage(error))
    live.removeSession(session.id)
    toast.success(`${session.student_name} was removed. They can join again with the same email.`)
  }

  if (live.loading) {
    return (
      <TeacherLoading variant="monitor" />
    )
  }

  return (
    <div className="space-y-4">
      {exam.status !== "open" && (
        <p className="rounded-lg border border-dashed px-4 py-3 text-sm text-muted-foreground">
          {exam.status === "draft"
            ? "This exam is still a draft. Click “Open exam” so students can join with the code."
            : "This exam is closed. New students can't join."}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-6 text-sm">
        <ConnectionBadge status={live.status} />
        <div className="flex items-center gap-2">
          <Switch id="pref-sound" checked={prefs.sound} onCheckedChange={(v) => onPrefsChange({ ...prefs, sound: v })} />
          <Label htmlFor="pref-sound" className="flex items-center gap-1.5 font-normal">
            <Volume2Icon className="size-4" />
            Sound on violations
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <Switch id="pref-desktop" checked={prefs.desktop} onCheckedChange={enableDesktop} />
          <Label htmlFor="pref-desktop" className="flex items-center gap-1.5 font-normal">
            <BellIcon className="size-4" />
            Desktop notifications when this tab is hidden
          </Label>
        </div>
      </div>

      {pending.length > 0 && (
        <Card className="ring-amber-500/50">
          <CardHeader>
            <CardTitle>Waiting for approval ({pending.length})</CardTitle>
            <CardDescription>Only approve students who are supposed to take this exam.</CardDescription>
            <CardAction>
              <Button size="sm" onClick={approveAll}>
                <CheckIcon />
                Approve all
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="divide-y">
            {pending.map((s) => (
              <div key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <div className="font-medium">{s.student_name}</div>
                  <div className="truncate text-sm text-muted-foreground">{s.student_email}</div>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => live.reviewRequest(s.id, false)}>
                    <XIcon />
                    Reject
                  </Button>
                  <Button size="sm" onClick={() => live.reviewRequest(s.id, true)}>
                    <CheckIcon />
                    Approve
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="grid items-start gap-4 lg:grid-cols-[1fr_340px]">
        <Card>
          <CardHeader>
            <CardTitle>Students ({students.length})</CardTitle>
            <CardDescription>
              Auto-submit at {exam.max_violations} violations · final warning at {exam.warn_at}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {students.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-12 text-center text-sm text-muted-foreground">
                <UsersIcon className="size-6" />
                No approved students yet. Share the exam code <span className="font-mono font-semibold">{exam.code}</span>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Student</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="w-40">Violations</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {students.map(({ session: s, status }) => (
                    <TableRow key={s.id} className={cn(status === "away" && "bg-red-500/5")}>
                      <TableCell>
                        <button type="button" className="text-left" onClick={() => setTimelineFor(s)}>
                          <div className="flex items-center gap-1.5 font-medium">
                            <span className="hover:underline">{s.student_name}</span>
                            {s.attempt > 1 && (
                              <Badge variant="outline" className="font-normal">
                                Attempt {s.attempt}
                              </Badge>
                            )}
                            {Number(s.deduction) > 0 && (
                              <Badge variant="destructive" className="font-normal" title="Points you deducted">
                                −{Number(s.deduction)} pts
                              </Badge>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground">{s.student_email}</div>
                        </button>
                      </TableCell>
                      <TableCell>
                        <StatusCell session={s} status={status} now={now} />
                      </TableCell>
                      <TableCell>
                        <ViolationMeter count={s.violation_count} exam={exam} />
                      </TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${s.student_name}`}>
                              <MoreHorizontalIcon />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onSelect={() => setTimelineFor(s)}>View timeline</DropdownMenuItem>
                            {s.status === "rejected" && (
                              <DropdownMenuItem onSelect={() => live.reviewRequest(s.id, true)}>Approve</DropdownMenuItem>
                            )}
                            {s.status === "in_progress" && (
                              <DropdownMenuItem onSelect={() => forceSubmit(s)}>Submit for student</DropdownMenuItem>
                            )}
                            {s.status !== "rejected" && (
                              <DropdownMenuItem onSelect={() => setDeducting(s)}>
                                <MinusCircleIcon />
                                Deduct points
                              </DropdownMenuItem>
                            )}
                            {(s.status === "submitted" || s.status === "auto_submitted") && (
                              <DropdownMenuItem onSelect={() => setRetaking(s)}>
                                <RotateCcwIcon />
                                Allow retake
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuSeparator />
                            <DropdownMenuItem variant="destructive" onSelect={() => setRemoving(s)}>
                              Remove student
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card className="lg:sticky lg:top-20">
          <CardHeader>
            <CardTitle>Live activity</CardTitle>
            <CardDescription>Newest first. Updates instantly.</CardDescription>
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-[480px] pr-3">
              {live.events.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">Nothing yet.</p>
              ) : (
                <ol className="space-y-3">
                  {live.events.map((e) => (
                    <FeedItem key={e.id} event={e} exam={exam} name={namesById.get(e.session_id)} />
                  ))}
                </ol>
              )}
            </ScrollArea>
          </CardContent>
        </Card>
      </div>

      <TimelineDialog
        session={timelineFor}
        events={live.events}
        exam={exam}
        onClose={() => setTimelineFor(null)}
      />

      <DeductPointsDialog session={deducting} onClose={() => setDeducting(null)} onDeducted={live.refresh} />

      <AlertDialog open={!!retaking} onOpenChange={(open) => !open && setRetaking(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Let {retaking?.student_name} retake the exam?</AlertDialogTitle>
            <AlertDialogDescription>
              Use this only for a valid exceptional reason, such as a serious connection problem or accident. Their
              current answers, score ({retaking?.score ?? 0}/{retaking?.max_score ?? 0}), violations and result code
              will be erased, and they start again as attempt {(retaking?.attempt ?? 1) + 1} on the same device. The
              activity log keeps a record of the earlier attempt.
              {exam.status !== "open" && " The exam is not open — reopen it first."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => retaking && allowRetake(retaking)} disabled={exam.status !== "open"}>
              Allow retake
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!removing} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.student_name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes their answers, score and activity log for this exam. They could then join again with the
              same email.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => removing && remove(removing)}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function ConnectionBadge({ status }: { status: ConnectionStatus }) {
  const meta = {
    live: { dot: "bg-emerald-500", label: "Live", tip: "Updates arrive instantly." },
    connecting: { dot: "bg-amber-500 animate-pulse", label: "Connecting…", tip: "Refreshing every few seconds meanwhile." },
    offline: {
      dot: "bg-amber-500",
      label: "Auto-refreshing",
      tip: "Live updates aren't connected, so the page refreshes itself every few seconds.",
    },
  }[status]
  return (
    <span className="flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs" title={meta.tip}>
      <span className={cn("size-2 rounded-full", meta.dot)} />
      {meta.label}
    </span>
  )
}

function StatusCell({ session, status, now }: { session: ExamSession; status: LiveStatus; now: number }) {
  const meta = LIVE_STATUS_META[status]
  let detail: string | null = null
  if (status === "away" || status === "idle") {
    detail = `for ${formatDuration((now - new Date(session.activity_since).getTime()) / 1000)}`
  } else if (status === "disconnected") {
    detail = `last seen ${formatDuration((now - new Date(session.last_seen_at).getTime()) / 1000)} ago`
  } else if ((status === "submitted" || status === "auto_submitted") && session.score !== null) {
    detail = `score ${session.score}/${session.max_score}`
  }
  return (
    <div className="flex items-center gap-2">
      <span className={cn("size-2.5 shrink-0 rounded-full", meta.dot, status === "away" && "animate-pulse")} />
      <div>
        <div className="text-sm">{meta.label}</div>
        {detail && <div className="text-xs text-muted-foreground">{detail}</div>}
      </div>
    </div>
  )
}

function ViolationMeter({ count, exam }: { count: number; exam: Exam }) {
  const danger = count >= exam.warn_at
  return (
    <div className="space-y-1">
      <div className={cn("text-sm tabular-nums", danger && "font-semibold text-destructive")}>
        {count} / {exam.max_violations}
      </div>
      <Progress
        value={Math.min(100, (count / exam.max_violations) * 100)}
        className={cn("h-1.5", danger && "[&>[data-slot=progress-indicator]]:bg-destructive")}
      />
    </div>
  )
}

function FeedItem({ event, exam, name }: { event: SessionEvent; exam: Exam; name?: string }) {
  return (
    <li className="flex gap-3">
      <EventIcon type={event.type} />
      <div className="min-w-0 text-sm">
        <div>
          <span className="font-medium">{name ?? "Removed student"}</span>{" "}
          <span className="text-muted-foreground">{lowerFirst(describeEvent(event, exam.max_violations))}</span>
        </div>
        <div className="text-xs text-muted-foreground">{formatTime(event.created_at)}</div>
      </div>
    </li>
  )
}

function TimelineDialog({
  session,
  events,
  exam,
  onClose,
}: {
  session: ExamSession | null
  events: SessionEvent[]
  exam: Exam
  onClose: () => void
}) {
  const items = session ? events.filter((e) => e.session_id === session.id) : []
  const awaySeconds = items.filter((e) => e.type === "returned").reduce((sum, e) => sum + (e.duration_seconds ?? 0), 0)
  const blocked = items.filter((e) => e.type === "blocked_action").length

  return (
    <Dialog open={!!session} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{session?.student_name}</DialogTitle>
          <DialogDescription>
            {session?.student_email} · {session?.violation_count ?? 0}/{exam.max_violations} violations · away{" "}
            {formatDuration(awaySeconds)} total · {blocked} blocked action{blocked === 1 ? "" : "s"}
            {Number(session?.deduction ?? 0) > 0 && ` · −${Number(session?.deduction)} points deducted`}
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[60vh] pr-3">
          <ol className="space-y-3">
            {items.map((e) => (
              <li key={e.id} className="flex gap-3">
                <EventIcon type={e.type} />
                <div className="text-sm">
                  <div className={cn(e.counted && "font-medium text-destructive")}>
                    {describeEvent(e, exam.max_violations)}
                  </div>
                  <div className="text-xs text-muted-foreground">{formatTime(e.created_at)}</div>
                </div>
              </li>
            ))}
            {items.length === 0 && <p className="text-sm text-muted-foreground">No activity recorded.</p>}
          </ol>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}

// Keeps free text (e.g. a deduction reason) intact, unlike toLowerCase().
function lowerFirst(text: string) {
  return text.charAt(0).toLowerCase() + text.slice(1)
}
