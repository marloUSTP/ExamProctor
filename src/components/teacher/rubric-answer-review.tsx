"use client"

import { useState } from "react"
import { ListChecksIcon, Loader2Icon, SparklesIcon } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { createClient } from "@/lib/supabase/client"
import { errorMessage } from "@/lib/format"
import { essayApproved, validateGrading } from "@/lib/rubric"
import { requestTeacherAi } from "@/lib/teacher-ai-client"
import { checkEssayWithRules, type RuleDraft } from "@/lib/rubric-rules"
import type { Answer, EssaySuggestion, Question } from "@/lib/types"

/** Remounted by the parent when the stored grade or current suggestion changes. */
export function RubricAnswerReview({ question, answer, sessionId, attempt, suggestion, aiQueueActive = false, onUpdated }: {
  question: Question; answer?: Answer; sessionId: string; attempt: number;
  suggestion?: EssaySuggestion; aiQueueActive?: boolean; onUpdated: () => Promise<void>
}) {
  const rubric = question.rubric!
  const approved = essayApproved(question, answer)
  const initial = approved ? answer?.rubric_grading : suggestion?.grading
  const [scores, setScores] = useState<Record<string, string>>(() => Object.fromEntries(
    rubric.criteria.map((c) => [c.id, String(initial?.criteria.find((g) => g.criterion_id === c.id)?.points ?? "")]),
  ))
  const [reasons, setReasons] = useState<Record<string, string>>(() => Object.fromEntries(
    rubric.criteria.map((c) => [c.id, initial?.criteria.find((g) => g.criterion_id === c.id)?.reason ?? ""]),
  ))
  const [feedback, setFeedback] = useState(initial?.feedback ?? "")
  const [ruleDraft, setRuleDraft] = useState<RuleDraft | null>(null)
  const [busy, setBusy] = useState(false)
  const [generating, setGenerating] = useState(false)
  const working = busy || generating
  const total = Math.round(rubric.criteria.reduce((sum, c) => sum + (Number(scores[c.id]) || 0), 0) * 1000000) / 1000000
  const hasRules = rubric.criteria.some((criterion) => criterion.checking_rule)

  function checkRules() {
    try {
      const draft = checkEssayWithRules(rubric, answer?.answer ?? "")
      setRuleDraft(draft)
      setScores(Object.fromEntries(draft.criteria.map((criterion) => [criterion.criterion_id, criterion.points === null ? "" : String(criterion.points)])))
      setReasons(Object.fromEntries(draft.criteria.map((criterion) => [criterion.criterion_id, criterion.points === null ? "" : criterion.reason])))
      setFeedback(draft.feedback)
      toast.success("Rule check ready. Review the matches and enter scores for manual criteria before approving.")
    } catch (error) { toast.error(errorMessage(error)) }
  }

  async function suggest() {
    setGenerating(true)
    try {
      await requestTeacherAi({ action: "grade-essay", sessionId, questionId: question.id })
      await onUpdated()
      toast.success("AI suggestion ready. Review each criterion before approving.")
    } catch (error) { toast.error(errorMessage(error)) }
    finally { setGenerating(false) }
  }

  async function approve() {
    if (rubric.criteria.some((c) => !scores[c.id]?.trim())) {
      toast.error("Enter points for every criterion, including 0 where appropriate.")
      return
    }
    const grading = { feedback, criteria: rubric.criteria.map((c) => ({
      criterion_id: c.id, points: Number(scores[c.id]), reason: reasons[c.id].trim() || "Teacher assessment",
      evidence: (ruleDraft ?? initial)?.criteria.find((g) => g.criterion_id === c.id)?.evidence ?? "",
    })) }
    try { validateGrading(grading, rubric, answer?.answer ?? "") }
    catch (error) { toast.error(errorMessage(error)); return }
    setBusy(true)
    try {
      const supabase = createClient()
      const { error } = suggestion && !approved && !ruleDraft
        ? await supabase.rpc("teacher_approve_essay_suggestion", { p_suggestion_id: suggestion.id, p_final_grading: grading })
        : await supabase.rpc("teacher_approve_rubric_answer", {
          p_session_id: sessionId, p_question_id: question.id, p_attempt: attempt,
          p_answer: answer?.answer ?? "", p_snapshot: { prompt: question.prompt, points: question.points, rubric },
          p_grading: grading,
        })
      if (error) throw error
      await onUpdated()
      toast.success("Rubric score approved")
    } catch (error) { toast.error(errorMessage(error)) }
    finally { setBusy(false) }
  }

  return (
    <div className="mt-3 space-y-3 border-t pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium">Rubric scoring</p>
        <Badge variant={approved ? "secondary" : "outline"}>{approved ? "Teacher approved" : ruleDraft ? "Rule draft awaiting approval" : suggestion ? "Suggestion awaiting approval" : "Awaiting teacher grading"}</Badge>
      </div>
      {!approved && <div className="space-y-2">
        <Button type="button" size="sm" variant="outline" disabled={working || !hasRules} onClick={checkRules}>
          <ListChecksIcon />{ruleDraft ? "Check again with rules" : "Check with rules"}
        </Button>
        <p className="text-xs text-muted-foreground">{hasRules
          ? "Checks configured concepts without AI provider calls or AI fees. Replaces unsaved scoring fields. Review meaning and correctness before approving; criteria without rules still need a teacher score."
          : "To check without AI, configure concept rules for this rubric in Questions & answer key and save the questions."}</p>
      </div>}
      {!approved && !suggestion && !ruleDraft && <div className="space-y-2">
        <Button type="button" size="sm" variant="outline" disabled={working || aiQueueActive} onClick={() => void suggest()}>
          {generating ? <Loader2Icon className="animate-spin" /> : <SparklesIcon />}
          {generating ? "Checking against rubric…" : "Suggest scores with AI"}
        </Button>
        <p role="status" className="text-xs text-muted-foreground">{aiQueueActive ? "The essay queue is running. Pause it before requesting an individual suggestion; reopen this review to load newly saved drafts." : generating
          ? "AI is reviewing this answer. This may take up to a minute; no score is awarded yet."
          : "Sends this question, rubric and answer to the configured providers (Google Gemini or Groq), including a backup if enabled. Generates a draft that replaces unsaved scoring fields. You can also score manually."}</p>
      </div>}
      {(suggestion || ruleDraft) && !approved && <p className="text-xs text-muted-foreground">Review the suggested points and explanations. Your approval makes the score final.</p>}
      {ruleDraft ? <p className="text-xs text-muted-foreground">Method: concept rules (no AI). This draft is saved only when you approve it.</p>
        : suggestion && !approved && <p className="text-xs text-muted-foreground">AI model: {suggestion.model}</p>}
      {rubric.criteria.map((c) => {
        const proposed = (ruleDraft ?? (!approved ? suggestion?.grading : undefined))?.criteria.find((g) => g.criterion_id === c.id)
        return (
          <div key={c.id} className="space-y-2 rounded-md border bg-background p-3">
            <div className="flex items-start justify-between gap-3">
              <Label htmlFor={`rubric-score-${question.id}-${c.id}`}>{c.name}</Label>
              <div className="flex shrink-0 items-center gap-1.5">
                <Input id={`rubric-score-${question.id}-${c.id}`} type="number" min={0} max={c.max_points} step="any"
                  value={scores[c.id]} disabled={working} className="h-8 w-20"
                  onChange={(e) => setScores((s) => ({ ...s, [c.id]: e.target.value }))} />
                <span className="text-xs text-muted-foreground">/ {c.max_points}</span>
              </div>
            </div>
            <p className="whitespace-pre-wrap text-xs text-muted-foreground">{c.description}</p>
            {proposed && <p className="text-xs text-muted-foreground">{proposed.points === null ? "Teacher score needed" : `Suggested: ${proposed.points}/${c.max_points}`} · {proposed.reason}</p>}
            {proposed?.evidence && <blockquote className="border-l-2 pl-2 text-xs italic">“{proposed.evidence}”</blockquote>}
            <Label htmlFor={`rubric-reason-${question.id}-${c.id}`}>Teacher explanation (optional)</Label>
            <Textarea id={`rubric-reason-${question.id}-${c.id}`} value={reasons[c.id]} maxLength={2000} rows={2} disabled={working}
              onChange={(e) => setReasons((r) => ({ ...r, [c.id]: e.target.value }))} />
          </div>
        )
      })}
      <Label htmlFor={`rubric-feedback-${question.id}`}>Overall feedback (optional)</Label>
      <Textarea id={`rubric-feedback-${question.id}`} value={feedback} onChange={(e) => setFeedback(e.target.value)} maxLength={4000} rows={2} disabled={working} />
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" disabled={working} onClick={() => void approve()}>
          {busy && <Loader2Icon className="animate-spin" />}{approved ? "Update approved score" : "Approve rubric score"}
        </Button>
        <span className="text-sm tabular-nums">Total: {total} / {question.points}</span>
      </div>
      <p className="text-xs text-muted-foreground">Students see the approved breakdown and feedback when their results are released.</p>
    </div>
  )
}
