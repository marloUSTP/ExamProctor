"use client"

import { useEffect, useState } from "react"
import {
  CheckCircle2Icon,
  DownloadIcon,
  EyeIcon,
  EyeOffIcon,
  Loader2Icon,
  MinusCircleIcon,
  RefreshCwIcon,
  XCircleIcon,
} from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Input } from "@/components/ui/input"
import { DeductPointsDialog } from "@/components/teacher/deduct-points-dialog"
import { RubricAnswerReview } from "@/components/teacher/rubric-answer-review"
import { EssaySuggestionQueue } from "@/components/teacher/essay-suggestion-queue"
import { EssayApprovalChecklist } from "@/components/teacher/essay-approval-checklist"
import { TeacherLoading } from "@/components/teacher/loading-skeleton"
import { essayApproved, suggestionMatches } from "@/lib/rubric"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { createClient } from "@/lib/supabase/client"
import { formatAnswer, formatKey, percent } from "@/lib/answers"
import { errorMessage } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { Answer, EssaySuggestion, Exam, ExamSession, Question } from "@/lib/types"

const FINISHED = new Set(["submitted", "auto_submitted"])

export function ResultsPanel({
  exam,
  questions,
  sessions,
  loading = false,
  onExamChange,
  onSessionsChange,
}: {
  exam: Exam
  questions: Question[]
  sessions: ExamSession[]
  loading?: boolean
  onExamChange: (exam: Exam) => void
  onSessionsChange: () => Promise<void>
}) {
  const [viewing, setViewing] = useState<ExamSession | null>(null)
  const [queueActive, setQueueActive] = useState(false)
  const [approvalActive, setApprovalActive] = useState(false)
  const [approvalVersion, setApprovalVersion] = useState(0)
  const [deducting, setDeducting] = useState<ExamSession | null>(null)
  const [busy, setBusy] = useState<"regrade" | "release" | null>(null)
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!exam.scheduled_end_at) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [exam.scheduled_end_at])

  const finished = sessions
    .filter((s) => FINISHED.has(s.status))
    .sort((a, b) => a.student_name.localeCompare(b.student_name))
  const stillTaking = sessions.filter((s) => s.status === "in_progress").length
  const awaitingGrading = finished.filter((s) => s.score === null).length
  const percents = finished.map((s) => percent(s.score, s.max_score)).filter((p): p is number => p !== null)
  const average = percents.length ? Math.round(percents.reduce((a, b) => a + b, 0) / percents.length) : null
  const examEnded = exam.status === "closed" || (!!exam.scheduled_end_at && Date.parse(exam.scheduled_end_at) <= now)
  const scoresVisible = !exam.results_hidden && (exam.results_released || examEnded)

  async function regrade() {
    setBusy("regrade")
    const { error } = await createClient().rpc("teacher_regrade_exam", { p_exam_id: exam.id })
    setBusy(null)
    if (error) toast.error(errorMessage(error))
    else { await onSessionsChange(); setApprovalVersion((v) => v + 1); toast.success("Submissions re-graded; teacher-approved essay scores preserved") }
  }

  async function toggleRelease() {
    setBusy("release")
    const { data, error } = await createClient()
      .from("exams")
      .update({ results_released: !scoresVisible, results_hidden: scoresVisible })
      .eq("id", exam.id)
      .select("*")
      .single()
    setBusy(null)
    if (error) return toast.error(errorMessage(error))
    onExamChange(data as Exam)
    toast.success(scoresVisible ? "Scores and answer review are hidden from students" : "Scores are released, including partial scores for submissions awaiting essay grading")
  }

  function exportCsv() {
    const header = ["Name", "Email", "Status", "Score", "Max score", "Percent", "Points deducted", "Violations", "Submitted at", "Attempt", "Result code", "Grading"]
    const rows = finished.map((s) => [
      s.student_name,
      s.student_email,
      s.status === "auto_submitted" ? "Auto-submitted" : "Submitted",
      s.score ?? "",
      s.max_score ?? "",
      percent(s.score, s.max_score) ?? "",
      Number(s.deduction) || "",
      s.violation_count,
      s.submitted_at ? new Date(s.submitted_at).toLocaleString() : "",
      s.attempt,
      s.result_code ?? "",
      s.score === null ? "Awaiting grading" : "Graded",
    ])
    const csv = [header, ...rows]
      .map((r) => r.map((v) => `"${String(v).replaceAll('"', '""')}"`).join(","))
      .join("\r\n")
    const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }))
    const a = Object.assign(document.createElement("a"), {
      href: url,
      download: `${exam.title.replace(/[^\w\- ]+/g, "").trim() || "exam"} - results.csv`,
    })
    a.click()
    URL.revokeObjectURL(url)
  }

  if (loading) return <TeacherLoading variant="results" />

  return (
    <div className="space-y-4">
      <EssaySuggestionQueue questions={questions} sessions={sessions} onActiveChange={setQueueActive} disabled={approvalActive}
        onReview={(id) => setViewing(sessions.find((session) => session.id === id) ?? null)} />
      <EssayApprovalChecklist questions={questions} sessions={sessions} aiQueueActive={queueActive || busy === "regrade"}
        refreshVersion={approvalVersion} onActiveChange={setApprovalActive} onUpdated={onSessionsChange}
        onReview={(id) => setViewing(sessions.find((session) => session.id === id) ?? null)} />
      <Card>
        <CardHeader>
          <CardTitle>Results</CardTitle>
          <CardDescription>
            {finished.length} submitted
            {awaitingGrading > 0 && ` · ${awaitingGrading} awaiting grading`}
            {stillTaking > 0 && ` · ${stillTaking} still taking the exam`}
            {average !== null && ` · class average ${average}%`}
          </CardDescription>
          <CardAction className="flex flex-wrap justify-end gap-2">
            <Button variant={scoresVisible ? "outline" : "default"} onClick={toggleRelease} disabled={busy !== null || approvalActive}>
              {busy === "release" ? (
                <Loader2Icon className="animate-spin" />
              ) : scoresVisible ? (
                <EyeOffIcon />
              ) : (
                <EyeIcon />
              )}
              {scoresVisible ? "Hide scores" : "Release scores"}
            </Button>
            <Button variant="outline" onClick={regrade} disabled={busy !== null || approvalActive || finished.length === 0}>
              {busy === "regrade" ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />}
              Re-grade all
            </Button>
            <Button variant="outline" onClick={exportCsv} disabled={finished.length === 0}>
              <DownloadIcon />
              Export CSV
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          {awaitingGrading > 0 && <p className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm">
            {awaitingGrading} submission{awaitingGrading === 1 ? " needs" : "s need"} teacher grading. Open View answers to approve essay points. Released results show partial scores until all essays are approved.
          </p>}
          {!scoresVisible && (
            <p className="mb-4 rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
              Students see scores, correct answers, and per-question points when the exam ends. You can release them early or keep them hidden with this control.
            </p>
          )}
          {finished.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">No submissions yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Student</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Score</TableHead>
                  <TableHead className="text-right">%</TableHead>
                  <TableHead className="text-right">Violations</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {finished.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell>
                      <div className="font-medium">{s.student_name}</div>
                      <div className="text-xs text-muted-foreground">{s.student_email}</div>
                    </TableCell>
                    <TableCell>
                      {s.status === "auto_submitted" ? (
                        <Badge variant="destructive">Auto-submitted</Badge>
                      ) : (
                        <Badge variant="secondary">Submitted</Badge>
                      )}
                      {s.result_code && (
                        <div className="mt-1 font-mono text-xs text-muted-foreground" title="Student's result code">
                          {s.result_code}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {s.score === null ? <Badge variant="outline">Awaiting grading</Badge> : `${s.score} / ${s.max_score ?? "—"}`}
                      {Number(s.deduction) > 0 && (
                        <div className="text-xs text-destructive">−{Number(s.deduction)} deducted</div>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{percent(s.score, s.max_score) ?? "—"}%</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {s.violation_count}/{exam.max_violations}
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      <Button variant="ghost" size="sm" onClick={() => setDeducting(s)}>
                        <MinusCircleIcon />
                        Deduct points
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setViewing(s)}>
                        View answers
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <AnswersDialog
        key={viewing?.id ?? "none"}
        session={viewing ? (sessions.find((s) => s.id === viewing.id) ?? viewing) : null}
        questions={questions}
        aiQueueActive={queueActive}
        onUpdated={async () => { setApprovalVersion((v) => v + 1); await onSessionsChange() }}
        onClose={() => setViewing(null)}
      />

      <DeductPointsDialog session={deducting} onClose={() => setDeducting(null)} onDeducted={onSessionsChange} />
    </div>
  )
}

function AnswersDialog({
  session,
  questions,
  aiQueueActive,
  onUpdated,
  onClose,
}: {
  session: ExamSession | null
  questions: Question[]
  aiQueueActive: boolean
  onUpdated: () => Promise<void>
  onClose: () => void
}) {
  const [answers, setAnswers] = useState<Map<string, Answer> | null>(null)
  const [scoreDrafts, setScoreDrafts] = useState<Record<string, string>>({})
  const [suggestions, setSuggestions] = useState<EssaySuggestion[]>([])
  const [saving, setSaving] = useState<string | null>(null)
  const sessionId = session?.id

  async function load(id: string) {
    const { data, error } = await createClient().from("answers").select("*").eq("session_id", id)
    if (error) toast.error(errorMessage(error))
    const rows = (data ?? []) as Answer[]
    setAnswers(new Map(rows.map((a) => [a.question_id, a])))
    setScoreDrafts(Object.fromEntries(rows.map((a) => [a.question_id, String(a.points_awarded ?? 0)])))
    const { data: proposals, error: proposalError } = await createClient().from("essay_suggestions").select("*").eq("session_id", id).order("created_at", { ascending: false })
    if (proposalError) toast.error("Rubric grading is unavailable. Apply the rubric grading database migration.")
    setSuggestions((proposals ?? []) as EssaySuggestion[])
  }

  // Parent re-mounts this dialog per student (key), so answers start as null for each one.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetching; state is set after the request returns
    if (sessionId) void load(sessionId)
  }, [sessionId])

  async function override(questionId: string, isCorrect: boolean) {
    if (!sessionId) return
    setSaving(questionId)
    const { error } = await createClient().rpc("teacher_override_answer", {
      p_session_id: sessionId,
      p_question_id: questionId,
      p_is_correct: isCorrect,
    })
    setSaving(null)
    if (error) return toast.error(errorMessage(error))
    await load(sessionId)
    await onUpdated()
  }

  async function saveScore(questionId: string, maxPoints: number) {
    if (!sessionId) return
    if (!scoreDrafts[questionId]?.trim()) {
      toast.error("Enter a score before saving.")
      return
    }
    const points = Number(scoreDrafts[questionId])
    if (!Number.isFinite(points) || points < 0 || points > maxPoints) {
      toast.error(`Enter a score from 0 to ${maxPoints}.`)
      return
    }
    setSaving(questionId)
    const { error } = await createClient().rpc("teacher_set_answer_score", {
      p_session_id: sessionId,
      p_question_id: questionId,
      p_points: points,
    })
    setSaving(null)
    if (error) return toast.error(errorMessage(error))
    await load(sessionId)
    await onUpdated()
    toast.success("Score approved")
  }

  return (
    <Dialog open={!!session} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{session?.student_name}</DialogTitle>
          <DialogDescription>
            {session?.score === null ? "Awaiting essay grading" : `Score ${session?.score ?? "—"} / ${session?.max_score ?? "—"}`} · Review and approve partial points below.
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[65vh] pr-3">
          {!answers ? (
            <TeacherLoading variant="answers" />
          ) : (
            <ol className="space-y-3">
              {questions.map((q, i) => {
                const a = answers.get(q.id)
                const pending = q.type === "essay" && !essayApproved(q, a)
                const suggestion = suggestions.find((s) => s.question_id === q.id && !s.approved_at && suggestionMatches(s, q, a?.answer ?? "", session?.attempt ?? 1))
                const awarded = Number(a?.points_awarded ?? 0)
                const correct = awarded >= Number(q.points) && Number(q.points) > 0
                const partial = awarded > 0 && !correct
                const canSetPartialScore = q.type === "essay" || q.type === "identification"
                return (
                  <li
                    key={q.id}
                    className={cn(
                      "rounded-lg border p-3",
                      pending ? "border-amber-500/40 bg-amber-500/5" : correct ? "border-emerald-500/40 bg-emerald-500/5" : partial ? "border-amber-500/40 bg-amber-500/5" : "border-red-500/30 bg-red-500/5"
                    )}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="text-sm font-medium">
                        {i + 1}. {q.prompt}
                      </div>
                      <div className="flex shrink-0 items-center gap-1 text-sm">
                        {pending ? <Badge variant="outline">Pending</Badge> : correct ? (
                          <CheckCircle2Icon className="size-4 text-emerald-600" />
                        ) : partial ? (
                          <span className="text-xs font-medium text-amber-700 dark:text-amber-400">Partial</span>
                        ) : (
                          <XCircleIcon className="size-4 text-red-600" />
                        )}
                        <span className="tabular-nums">
                          {pending ? "—" : a?.points_awarded ?? 0}/{q.points}
                        </span>
                      </div>
                    </div>
                    <dl className="mt-2 grid gap-1 text-sm sm:grid-cols-[110px_1fr]">
                      <dt className="text-muted-foreground">Their answer</dt>
                      <dd className="whitespace-pre-wrap">{formatAnswer(q.type, q.choices, a?.answer)}</dd>
                      <dt className="text-muted-foreground">Answer key</dt>
                      <dd>{formatKey(q.type, q.choices, q.correct_answers)}</dd>
                    </dl>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {a?.overridden && !pending && <Badge variant="outline">Teacher approved</Badge>}
                      {canSetPartialScore && !(q.type === "essay" && q.rubric) && (
                        <div className="flex items-center gap-1.5">
                          <label htmlFor={`score-${q.id}`} className="text-xs text-muted-foreground">Points</label>
                          <Input
                            id={`score-${q.id}`}
                            type="number"
                            min={0}
                            max={q.points}
                            step="any"
                            value={scoreDrafts[q.id] ?? String(awarded)}
                            onChange={(event) => setScoreDrafts((drafts) => ({ ...drafts, [q.id]: event.target.value }))}
                            className="h-8 w-20 tabular-nums"
                          />
                          <span className="text-xs text-muted-foreground">/ {q.points}</span>
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={saving === q.id || (!pending && Number(scoreDrafts[q.id] ?? awarded) === awarded)}
                            onClick={() => void saveScore(q.id, Number(q.points))}
                          >
                            {saving === q.id ? <Loader2Icon className="animate-spin" /> : q.type === "essay" ? "Approve score" : "Save"}
                          </Button>
                        </div>
                      )}
                      {!(q.type === "essay" && q.rubric) && <><Button
                        size="xs"
                        variant="outline"
                        disabled={saving === q.id || correct}
                        onClick={() => override(q.id, true)}
                      >
                        Mark correct
                      </Button>
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={saving === q.id || (!pending && awarded <= 0)}
                        onClick={() => override(q.id, false)}
                      >
                        Mark wrong
                      </Button></>}
                    </div>
                    {q.type === "essay" && q.rubric && session && <RubricAnswerReview
                      key={`${q.id}-${a?.graded_at ?? "pending"}-${suggestion?.id ?? "manual"}-${JSON.stringify([q.prompt, q.points, q.rubric, a?.answer, session.attempt])}`} question={q} answer={a}
                      sessionId={session.id} attempt={session.attempt} suggestion={suggestion}
                      aiQueueActive={aiQueueActive}
                      onUpdated={async () => { await load(session.id); await onUpdated() }}
                    />}
                  </li>
                )
              })}
            </ol>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
