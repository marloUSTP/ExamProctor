"use client"

import { useMemo, useRef, useState } from "react"
import { ArrowDownIcon, ArrowUpIcon, Loader2Icon, PlusIcon, SaveIcon, Trash2Icon, XIcon } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { hasAnswer, PasteQuestionsDialog } from "@/components/teacher/paste-questions-dialog"
import { RubricEditor } from "@/components/teacher/rubric-editor"
import { validateRubric } from "@/lib/rubric"
import { createClient } from "@/lib/supabase/client"
import { errorMessage, QUESTION_TYPE_LABEL } from "@/lib/format"
import type { ParsedQuestion } from "@/lib/parse-questions"
import type { Exam, Question, QuestionType, Rubric } from "@/lib/types"

interface Draft {
  id: string
  type: QuestionType
  prompt: string
  choices: string[]
  /** multiple_choice: index as string; true_false: "true" | "false" */
  correct: string
  /** identification: one accepted answer per line */
  accepted: string
  points: number
  rubric: Rubric | null
  rubricSource: string
}

const LETTERS = "ABCDEFGHIJ"

function toDraft(q: Question): Draft {
  return {
    id: q.id,
    type: q.type,
    prompt: q.prompt,
    choices: q.type === "multiple_choice" ? q.choices : [],
    correct: q.type === "identification" ? "" : (q.correct_answers[0] ?? ""),
    accepted: q.type === "identification" ? q.correct_answers.join("\n") : "",
    points: q.points,
    rubric: q.rubric ?? null,
    rubricSource: q.rubric_source_text ?? "",
  }
}

function newDraft(type: QuestionType): Draft {
  return {
    id: crypto.randomUUID(),
    type,
    prompt: "",
    choices: type === "multiple_choice" ? ["", "", "", ""] : [],
    correct: type === "true_false" ? "true" : "",
    accepted: "",
    points: type === "essay" ? 10 : 1,
    rubric: null,
    rubricSource: "",
  }
}

function acceptedList(d: Draft) {
  return d.accepted
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
}

function validate(d: Draft, n: number): string | null {
  if (!Number.isInteger(d.points) || d.points < 0 || d.points > 100) return `Question ${n}: enter a whole-number point limit from 0 to 100.`
  if (d.type === "essay" && d.rubric) {
    try { validateRubric(d.rubric, d.points) }
    catch (error) { return `Question ${n}: ${error instanceof Error ? error.message : "Check the rubric."}` }
  }
  if (!d.prompt.trim()) return `Question ${n}: write the question.`
  if (d.type === "multiple_choice") {
    if (d.choices.some((c) => !c.trim())) return `Question ${n}: fill in every choice or remove the empty ones.`
    if (d.choices.length < 2) return `Question ${n}: add at least 2 choices.`
    if (d.correct === "" || Number(d.correct) >= d.choices.length) return `Question ${n}: mark the correct choice.`
  }
  if (d.type === "identification" && acceptedList(d).length === 0) return `Question ${n}: enter the correct answer.`
  return null
}

export function QuestionsEditor({
  exam,
  questions,
  onSaved,
}: {
  exam: Exam
  questions: Question[]
  onSaved: (questions: Question[]) => void
}) {
  const [drafts, setDrafts] = useState<Draft[]>(() => questions.map(toDraft))
  const [savedSnapshot, setSavedSnapshot] = useState(() => JSON.stringify(questions.map(toDraft)))
  const [saving, setSaving] = useState(false)
  const [newType, setNewType] = useState<QuestionType>("multiple_choice")
  const toolbarRef = useRef<HTMLDivElement>(null)
  const pendingFocusId = useRef<string | null>(null)

  const dirty = useMemo(() => JSON.stringify(drafts) !== savedSnapshot, [drafts, savedSnapshot])
  const totalPoints = drafts.reduce((sum, d) => sum + (Number(d.points) || 0), 0)

  function update(id: string, patch: Partial<Draft>) {
    setDrafts((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)))
  }

  function addQuestion() {
    const draft = newDraft(newType)
    pendingFocusId.current = draft.id
    setDrafts((prev) => [...prev, draft])
  }

  function focusAddedQuestion(element: HTMLTextAreaElement | null, id: string) {
    if (!element || pendingFocusId.current !== id) return
    pendingFocusId.current = null
    const card = element.closest<HTMLElement>("[data-question-card]")
    const toolbar = toolbarRef.current
    if (card && toolbar) {
      // Leave room for the sticky toolbar, including its extra rows on phones.
      const top = Number.parseFloat(getComputedStyle(toolbar).top) || 0
      card.style.scrollMarginTop = `${top + toolbar.getBoundingClientRect().height + 16}px`
    }
    element.focus({ preventScroll: true })
    ;(card ?? element).scrollIntoView({
      block: "start",
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
    })
  }

  function importParsed(parsed: ParsedQuestion[]) {
    const added: Draft[] = parsed.map((q) => ({
      id: crypto.randomUUID(),
      type: q.type,
      prompt: q.prompt,
      choices: q.choices,
      correct: q.correct,
      accepted: q.accepted.join("\n"),
      points: q.points ?? 1,
      rubric: null,
      rubricSource: "",
    }))
    setDrafts((prev) => [...prev, ...added])
    const missing = parsed.filter((q) => !hasAnswer(q)).length
    toast.success(`Added ${added.length} question${added.length === 1 ? "" : "s"}`, {
      description: missing
        ? `Mark the correct answer for ${missing} of them (highlighted), then click “Save questions”.`
        : "Review them, then click “Save questions”.",
    })
  }

  function move(index: number, delta: number) {
    setDrafts((prev) => {
      const next = prev.slice()
      const [item] = next.splice(index, 1)
      next.splice(index + delta, 0, item)
      return next
    })
  }

  async function save() {
    for (let i = 0; i < drafts.length; i++) {
      const problem = validate(drafts[i], i + 1)
      if (problem) {
        toast.error(problem)
        return
      }
    }

    const rows = drafts.map((d, i) => ({
      id: d.id,
      exam_id: exam.id,
      position: i,
      type: d.type,
      prompt: d.prompt.trim(),
      choices: d.type === "multiple_choice" ? d.choices.map((c) => c.trim()) : [],
      correct_answers: d.type === "identification" ? acceptedList(d) : d.type === "essay" ? [] : [d.correct],
      points: Math.max(0, Math.min(100, Math.round(Number(d.points) || 0))),
      rubric: d.type === "essay" ? d.rubric : null,
      rubric_source_text: d.type === "essay" ? d.rubricSource : "",
    }))
    const keep = new Set(rows.map((r) => r.id))
    const removed = questions.filter((q) => !keep.has(q.id)).map((q) => q.id)

    setSaving(true)
    const supabase = createClient()
    try {
      if (removed.length) {
        const { error } = await supabase.from("questions").delete().in("id", removed)
        if (error) throw error
      }
      if (rows.length) {
        const { error } = await supabase.from("questions").upsert(rows)
        if (error) throw error
      }
      const saved = rows.map((r) => ({ ...r })) as Question[]
      onSaved(saved)
      setSavedSnapshot(JSON.stringify(drafts))
      toast.success("Questions and answer key saved")
      if (exam.status !== "draft") {
        toast.info("If students already submitted, use “Re-grade all” in Results to apply the new answer key.")
      }
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <div ref={toolbarRef} className="sticky top-14 z-20 -mx-4 flex flex-wrap items-center justify-between gap-3 border-b bg-background/95 px-4 py-3 backdrop-blur">
        <div className="text-sm text-muted-foreground">
          {drafts.length} question{drafts.length === 1 ? "" : "s"} · {totalPoints} point{totalPoints === 1 ? "" : "s"} total
          {dirty && (
            <Badge variant="outline" className="ml-2">
              Unsaved changes
            </Badge>
          )}
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 lg:w-auto">
          <Select value={newType} onValueChange={(v) => setNewType(v as QuestionType)}>
            <SelectTrigger className="w-48" aria-label="Question type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(QUESTION_TYPE_LABEL) as QuestionType[]).map((t) => (
                <SelectItem key={t} value={t}>
                  {QUESTION_TYPE_LABEL[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" onClick={addQuestion}>
            <PlusIcon />
            Add question
          </Button>
          <span className="text-sm text-muted-foreground">or</span>
          <PasteQuestionsDialog onImport={importParsed} />
          <Button className="ml-auto" onClick={save} disabled={!dirty || saving}>
            {saving ? <Loader2Icon className="animate-spin" /> : <SaveIcon />}
            Save questions
          </Button>
        </div>
      </div>

      {drafts.length === 0 && (
        <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          No questions yet. Use the controls above to add questions or import a questionnaire from Word or a text-based PDF.
        </p>
      )}

      {drafts.map((d, index) => {
        const needsAnswer =
          d.type === "essay"
            ? false
            : d.type === "identification"
              ? acceptedList(d).length === 0
              : d.correct === ""
        return (
        <Card key={d.id} data-question-card className={needsAnswer ? "ring-amber-500/50" : undefined}>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2 text-base">
              Question {index + 1}
              <Badge variant="secondary">{QUESTION_TYPE_LABEL[d.type]}</Badge>
              {needsAnswer && (
                <Badge variant="outline" className="border-amber-500/50 text-amber-700 dark:text-amber-400">
                  Set the correct answer
                </Badge>
              )}
            </CardTitle>
            <CardAction className="flex items-center gap-1">
              <Button variant="ghost" size="icon-sm" disabled={index === 0} onClick={() => move(index, -1)} aria-label="Move up">
                <ArrowUpIcon />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={index === drafts.length - 1}
                onClick={() => move(index, 1)}
                aria-label="Move down"
              >
                <ArrowDownIcon />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setDrafts((prev) => prev.filter((x) => x.id !== d.id))}
                aria-label="Delete question"
              >
                <Trash2Icon />
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-[1fr_100px]">
              <div className="space-y-2">
                <Label htmlFor={`prompt-${d.id}`}>Question</Label>
                <Textarea
                  ref={(element) => focusAddedQuestion(element, d.id)}
                  id={`prompt-${d.id}`}
                  value={d.prompt}
                  onChange={(e) => update(d.id, { prompt: e.target.value })}
                  placeholder="Type the question…"
                  rows={2}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor={`points-${d.id}`}>Points</Label>
                <Input
                  id={`points-${d.id}`}
                  type="number"
                  min={0}
                  max={100}
                  value={d.points}
                  onChange={(e) => update(d.id, { points: Number(e.target.value) })}
                />
              </div>
            </div>

            {d.type === "multiple_choice" && (
              <div className="space-y-2">
                <Label>Choices — select the correct answer</Label>
                <RadioGroup value={d.correct} onValueChange={(v) => update(d.id, { correct: v })} className="gap-2">
                  {d.choices.map((choice, ci) => (
                    <div key={ci} className="flex items-center gap-3">
                      <RadioGroupItem value={String(ci)} id={`c-${d.id}-${ci}`} aria-label={`Mark ${LETTERS[ci]} as correct`} />
                      <span className="w-4 text-sm font-medium text-muted-foreground">{LETTERS[ci]}</span>
                      <Input
                        value={choice}
                        placeholder={`Choice ${LETTERS[ci]}`}
                        onChange={(e) => {
                          const choices = d.choices.slice()
                          choices[ci] = e.target.value
                          update(d.id, { choices })
                        }}
                        className={d.correct === String(ci) ? "border-emerald-500" : undefined}
                      />
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={d.choices.length <= 2}
                        aria-label={`Remove choice ${LETTERS[ci]}`}
                        onClick={() => {
                          const choices = d.choices.filter((_, i) => i !== ci)
                          const current = Number(d.correct)
                          const correct =
                            d.correct === "" || current === ci ? "" : String(current > ci ? current - 1 : current)
                          update(d.id, { choices, correct })
                        }}
                      >
                        <XIcon />
                      </Button>
                    </div>
                  ))}
                </RadioGroup>
                {d.choices.length < 6 && (
                  <Button variant="outline" size="sm" onClick={() => update(d.id, { choices: [...d.choices, ""] })}>
                    <PlusIcon />
                    Add choice
                  </Button>
                )}
              </div>
            )}

            {d.type === "true_false" && (
              <div className="space-y-2">
                <Label>Correct answer</Label>
                <RadioGroup value={d.correct} onValueChange={(v) => update(d.id, { correct: v })} className="flex gap-6">
                  {["true", "false"].map((v) => (
                    <div key={v} className="flex items-center gap-2">
                      <RadioGroupItem value={v} id={`tf-${d.id}-${v}`} />
                      <Label htmlFor={`tf-${d.id}-${v}`} className="font-normal">
                        {v === "true" ? "True" : "False"}
                      </Label>
                    </div>
                  ))}
                </RadioGroup>
              </div>
            )}

            {d.type === "identification" && (
              <div className="space-y-2">
                <Label htmlFor={`acc-${d.id}`}>Correct answer(s) — one per line</Label>
                <Textarea
                  id={`acc-${d.id}`}
                  value={d.accepted}
                  onChange={(e) => update(d.id, { accepted: e.target.value })}
                  placeholder={"Jose Rizal\nRizal\nDr. Jose Rizal"}
                  rows={3}
                />
                <p className="text-xs text-muted-foreground">
                  Uppercase/lowercase and extra spaces are ignored. You can still mark an answer correct by hand in Results.
                </p>
              </div>
            )}

            {d.type === "essay" && (
              <RubricEditor id={d.id} rubric={d.rubric} points={d.points} source={d.rubricSource}
                onSourceChange={(rubricSource) => update(d.id, { rubricSource })} onChange={(rubric) => update(d.id, { rubric })} />
            )}
          </CardContent>
        </Card>
        )
      })}

    </div>
  )
}
