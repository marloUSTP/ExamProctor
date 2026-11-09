"use client"

import { useEffect, useRef, useState } from "react"
import { CheckCheckIcon, Loader2Icon, RefreshCwIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { createClient } from "@/lib/supabase/client"
import { approveEssaySelection, type ApprovalOutcome, type ApprovalSession, type EssayApprovalItem } from "@/lib/essay-approval"
import { loadEssayApprovals } from "@/lib/essay-approval-client"
import { errorMessage } from "@/lib/format"
import type { EssaySuggestion, ExamSession, Question } from "@/lib/types"

const defaultServices = {
  load: (questions: Question[], sessions: ApprovalSession[], cancelled: () => boolean) => loadEssayApprovals(createClient(), questions, sessions, cancelled),
  approve: async (suggestion: EssaySuggestion) => {
    const { error } = await createClient().rpc("teacher_approve_essay_suggestion", {
      p_suggestion_id: suggestion.id, p_final_grading: suggestion.grading,
    })
    if (error) throw error
  },
}
const statusLabel = { ready: "Ready for review", approved: "Approved", missing: "No suggestion", stale: "Needs a new suggestion", invalid: "Needs correction" }
const PAGE_SIZE = 20

export function EssayApprovalChecklist({ questions, sessions, aiQueueActive, refreshVersion, onReview, onUpdated, onActiveChange, services = defaultServices }: {
  questions: Question[]; sessions: ExamSession[]; aiQueueActive: boolean; refreshVersion: number
  onReview: (sessionId: string) => void; onUpdated: () => Promise<void>; onActiveChange: (active: boolean) => void
  services?: typeof defaultServices
}) {
  const [items, setItems] = useState<EssayApprovalItem[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [outcomes, setOutcomes] = useState<Record<string, ApprovalOutcome>>({})
  const [loading, setLoading] = useState(true)
  const [approving, setApproving] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [revision, setRevision] = useState(0)
  const [search, setSearch] = useState("")
  const [filter, setFilter] = useState("all")
  const [page, setPage] = useState(0)
  const [message, setMessage] = useState("")
  const [loadError, setLoadError] = useState("")
  const [progress, setProgress] = useState({ completed: 0, total: 0 })
  const mounted = useRef(false)
  const locked = useRef(false)
  const stop = useRef(false)
  // Student heartbeats do not change this key or restart an in-flight checklist read.
  const inputs = JSON.stringify({ questions: questions.filter((q) => q.type === "essay" && q.rubric),
    sessions: sessions.filter((s) => ["submitted", "auto_submitted"].includes(s.status)).map((s) => ({
      id: s.id, student_name: s.student_name, student_email: s.student_email, status: s.status, attempt: s.attempt,
    })).sort((a, b) => a.id.localeCompare(b.id)) })

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; stop.current = true }
  }, [])
  useEffect(() => { onActiveChange(approving); return () => onActiveChange(false) }, [approving, onActiveChange])
  useEffect(() => {
    if (aiQueueActive || approving) return
    let cancelled = false
    async function load() {
      setLoading(true); setLoadError("")
      try {
        const context = JSON.parse(inputs) as { questions: Question[]; sessions: ApprovalSession[] }
        const rows = await services.load(context.questions, context.sessions, () => cancelled)
        if (cancelled) return
        setItems(rows)
        const ready = new Set(rows.filter((r) => r.status === "ready").map((r) => r.suggestion!.id))
        setSelected((current) => new Set([...current].filter((id) => ready.has(id))))
      } catch (error) {
        if (!cancelled) setLoadError(errorMessage(error))
      } finally { if (!cancelled) setLoading(false) }
    }
    void load()
    return () => { cancelled = true }
  }, [inputs, aiQueueActive, approving, refreshVersion, revision, services])

  const busy = loading || approving || aiQueueActive || !!loadError
  const isApproved = (item: EssayApprovalItem) => item.status === "approved" || (!!item.suggestion && outcomes[item.suggestion.id]?.status === "approved")
  const canSelect = (item: EssayApprovalItem) => item.status === "ready" && !!item.suggestion && !outcomes[item.suggestion.id]
  const ready = items.filter(canSelect)
  const chosen = ready.filter((item) => selected.has(item.suggestion!.id))
  const matches = items.filter((item) => {
    const text = `${item.session.student_name} ${item.session.student_email} ${item.question.prompt} Q${item.question.position + 1}`.toLowerCase()
    return text.includes(search.toLowerCase()) && (filter === "all" || (filter === "ready" ? canSelect(item)
      : filter === "approved" ? isApproved(item) : !isApproved(item) && !canSelect(item)))
  })
  const maxPage = Math.max(0, Math.ceil(matches.length / PAGE_SIZE) - 1)
  const currentPage = Math.min(page, maxPage)
  const visible = matches.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)
  const selectableMatches = matches.filter(canSelect)

  async function approve() {
    if (locked.current || busy || !chosen.length) return
    locked.current = true; stop.current = false
    const ids = new Set(chosen.map((item) => item.suggestion!.id))
    setApproving(true); setStopping(false); setMessage(""); setProgress({ completed: 0, total: ids.size })
    try {
      const results = await approveEssaySelection(items, ids, {
        approve: services.approve, shouldStop: () => stop.current || !mounted.current,
        update: (outcome) => {
          if (!mounted.current) return
          setOutcomes((previous) => ({ ...previous, [outcome.id]: outcome }))
          setSelected((previous) => { const next = new Set(previous); next.delete(outcome.id); return next })
          setProgress((previous) => ({ ...previous, completed: previous.completed + 1 }))
        },
      })
      if (!mounted.current) return
      const approved = results.filter((r) => r.status === "approved").length
      const failed = results.length - approved
      setMessage(`${approved} score${approved === 1 ? "" : "s"} approved. ${failed} need${failed === 1 ? "s" : ""} attention. ${ids.size - results.length} left unprocessed.`)
      try { await onUpdated() }
      catch { if (mounted.current) setMessage((text) => `${text} The results list could not refresh; refresh it before continuing.`) }
    } finally {
      locked.current = false
      if (mounted.current) { setApproving(false); setStopping(false) }
    }
  }

  if (!questions.some((q) => q.type === "essay" && q.rubric)) return null
  return <Card>
    <CardHeader>
      <CardTitle>AI score approval checklist</CardTitle>
      <CardDescription>Review each student response against the rubric, then select the scores you want to approve together.</CardDescription>
    </CardHeader>
    <CardContent className="space-y-4">
      <p className="text-sm text-muted-foreground">Expand an answer to check the rubric points, AI explanation and quoted evidence. Use Review and edit to change a score before approving. Only selected, current suggestions will be saved.</p>
      <div className="flex flex-wrap items-center gap-2">
        <Input aria-label="Search score checklist" placeholder="Search student or question…" className="sm:max-w-xs" value={search} onChange={(e) => { setSearch(e.target.value); setPage(0) }} />
        <select aria-label="Filter score checklist" className="h-9 rounded-md border bg-background px-3 text-sm" value={filter} onChange={(e) => { setFilter(e.target.value); setPage(0) }}>
          <option value="all">All answers</option><option value="ready">Ready for review</option><option value="attention">Needs attention</option><option value="approved">Approved</option>
        </select>
        <Button size="sm" variant="outline" disabled={approving || aiQueueActive || loading} onClick={() => { setOutcomes({}); setRevision((r) => r + 1) }}><RefreshCwIcon />Refresh checklist</Button>
      </div>
      <p className="text-sm">{ready.length} ready for review · {items.filter(isApproved).length} approved · {chosen.length} selected</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={busy || !selectableMatches.length} onClick={() => setSelected((previous) => new Set([...previous, ...selectableMatches.map((i) => i.suggestion!.id)]))}>Select all ready in this view ({selectableMatches.length})</Button>
        <Button size="sm" variant="ghost" disabled={approving || !selected.size} onClick={() => setSelected(new Set())}>Clear selection</Button>
        <Button disabled={busy || !chosen.length} onClick={() => void approve()}>{approving ? <Loader2Icon className="animate-spin" /> : <CheckCheckIcon />}Approve selected scores ({chosen.length})</Button>
        {approving && <Button variant="outline" disabled={stopping} onClick={() => { stop.current = true; setStopping(true) }}>{stopping ? "Stopping…" : "Stop after current score"}</Button>}
      </div>
      {aiQueueActive && <p role="status" className="text-sm text-muted-foreground">Pause the AI suggestion queue before approving. The checklist refreshes when it stops.</p>}
      {loading && !aiQueueActive && <p role="status" className="flex items-center gap-2 text-sm"><Loader2Icon className="size-4 animate-spin" />Loading saved rubric scores…</p>}
      {loadError && <p role="alert" className="text-sm text-destructive">{loadError} Refresh the checklist before approving.</p>}
      {!!progress.total && <div className="space-y-1"><progress aria-label="Score approval progress" className="h-2 w-full accent-primary" max={progress.total} value={progress.completed} /><p role="status" className="text-sm">{approving ? `${progress.completed} of ${progress.total} selected scores processed` : message}</p></div>}
      {!loading && !loadError && <>
        {!matches.length && <p className="py-4 text-sm text-muted-foreground">No matching rubric answers. Generate pending essay suggestions above, or change the search and filter.</p>}
        <ul className="space-y-3">{visible.map((item) => {
          const proposal = item.suggestion
          const outcome = proposal ? outcomes[proposal.id] : undefined
          return <li key={item.id} className="rounded-lg border p-3">
            <div className="flex items-start gap-3">
              <input type="checkbox" className="mt-1 size-4 shrink-0 accent-primary" aria-label={`Select ${item.session.student_name}, question ${item.question.position + 1}`}
                disabled={busy || !canSelect(item)} checked={!!proposal && selected.has(proposal.id) && canSelect(item)}
                onChange={(e) => { if (proposal) setSelected((previous) => { const next = new Set(previous); if (e.target.checked) next.add(proposal.id); else next.delete(proposal.id); return next }) }} />
              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div><p className="text-sm font-medium">{item.session.student_name} · Q{item.question.position + 1}</p><p className="text-xs text-muted-foreground">{item.session.student_email}</p></div>
                  <p className="text-sm tabular-nums">{item.total !== undefined && `${item.total} / ${item.question.points} · `}{outcome ? outcome.status === "approved" ? "Approved" : "Needs attention" : statusLabel[item.status]}</p>
                </div>
                <p className="whitespace-pre-wrap text-sm">{item.question.prompt}</p>
                {(outcome?.message || item.message) && <p role={outcome?.message ? "alert" : undefined} className="text-xs text-muted-foreground">{outcome?.message ?? item.message}</p>}
                <details className="text-sm"><summary className="cursor-pointer font-medium">Review response and rubric</summary>
                  <div className="mt-3 space-y-3">
                    <div><p className="font-medium">Student response</p><p className="mt-1 whitespace-pre-wrap">{item.answer || "No response"}</p></div>
                    {item.question.rubric!.criteria.map((criterion) => {
                      const grade = item.grading?.criteria.find((g) => g.criterion_id === criterion.id)
                      return <div key={criterion.id} className="space-y-1 rounded-md bg-muted/40 p-3">
                        <p className="font-medium">{criterion.name} · {grade ? `${grade.points} / ${criterion.max_points}` : `Up to ${criterion.max_points} points`}</p>
                        <p className="whitespace-pre-wrap text-xs text-muted-foreground">{criterion.description}</p>
                        {grade && <><p className="whitespace-pre-wrap">{grade.reason}</p>{grade.evidence ? <blockquote className="whitespace-pre-wrap border-l-2 pl-2 text-xs italic">“{grade.evidence}”</blockquote> : <p className="text-xs text-muted-foreground">No quoted evidence supplied.</p>}</>}
                      </div>
                    })}
                    {item.grading && <p className="whitespace-pre-wrap">{item.grading.feedback}</p>}
                    {proposal && <p className="text-xs text-muted-foreground">AI model: {proposal.model}</p>}
                  </div>
                </details>
                <Button size="sm" variant="outline" disabled={approving || aiQueueActive} onClick={() => onReview(item.session.id)}>Review and edit</Button>
              </div>
            </div>
          </li>
        })}</ul>
        {matches.length > PAGE_SIZE && <div className="flex flex-wrap items-center justify-between gap-2 text-sm"><span>Showing {currentPage * PAGE_SIZE + 1}–{Math.min((currentPage + 1) * PAGE_SIZE, matches.length)} of {matches.length}. Selection includes all pages in this view.</span><div className="flex gap-2"><Button size="sm" variant="outline" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>Previous</Button><Button size="sm" variant="outline" disabled={currentPage >= maxPage} onClick={() => setPage(currentPage + 1)}>Next</Button></div></div>}
      </>}
      <p className="text-xs text-muted-foreground">Approval saves the displayed AI scores and feedback. Released results update as scores are approved. Keep this exam page open until processing finishes; closing it leaves remaining scores unapproved.</p>
    </CardContent>
  </Card>
}
