"use client"

import { useRef, useState } from "react"
import { Loader2Icon, PlusIcon, SparklesIcon, Trash2Icon, UploadIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { CriterionPointsInput } from "@/components/teacher/criterion-points-input"
import { readDocument } from "@/lib/read-document"
import { requestTeacherAi } from "@/lib/teacher-ai-client"
import { MAX_CRITERIA, MAX_RUBRIC_TEXT, MAX_RULE_TEXT, rubricTotal } from "@/lib/rubric"
import type { Rubric, RubricCheckingRule } from "@/lib/types"

export function RubricEditor({ id, rubric, points, source, onSourceChange, onChange }: {
  id: string; rubric: Rubric | null; points: number; source: string;
  onSourceChange: (source: string) => void; onChange: (rubric: Rubric | null) => void
}) {
  const [operation, setOperation] = useState<"upload" | "extract" | null>(null)
  const busy = operation !== null
  const fileInput = useRef<HTMLInputElement>(null)
  const criteria = rubric?.criteria ?? []

  async function upload(file: File) {
    setOperation("upload")
    try {
      const text = await readDocument(file)
      if (text.length > MAX_RUBRIC_TEXT) throw new Error(`Use a rubric with at most ${MAX_RUBRIC_TEXT.toLocaleString()} characters.`)
      onSourceChange(text)
      toast.success("Rubric loaded. Extract criteria with AI or add them below.")
    } catch (error) { toast.error(error instanceof Error ? error.message : "Could not read the rubric.") }
    finally { setOperation(null); if (fileInput.current) fileInput.current.value = "" }
  }

  async function extract() {
    setOperation("extract")
    try {
      const result = await requestTeacherAi({ action: "extract-rubric", source, points })
      onChange(result.rubric)
      toast.success("Criteria extracted. Review the descriptions and point totals, then save the questions.")
    } catch (error) { toast.error(error instanceof Error ? error.message : "Could not extract criteria.") }
    finally { setOperation(null) }
  }

  return (
    <fieldset disabled={busy} className="min-w-0 space-y-3 rounded-lg border bg-muted/20 p-3" aria-busy={busy}>
      <div>
        <p className="text-sm font-medium">Grading rubric</p>
        <p className="text-xs text-muted-foreground">Enter your rubric criteria and optional concept rules for automatic checking without AI. You can also upload or paste a rubric as reference.</p>
      </div>
      <Label htmlFor={`rubric-source-${id}`}>Rubric document text (optional)</Label>
      <Textarea id={`rubric-source-${id}`} value={source} onChange={(e) => onSourceChange(e.target.value)} maxLength={MAX_RUBRIC_TEXT}
        placeholder="Paste criteria, point limits, and descriptions for each performance level…" rows={3} disabled={busy} />
      <div className="flex flex-wrap gap-2">
        <input ref={fileInput} type="file" accept=".docx,.pdf,.txt" className="hidden" aria-label="Choose a rubric document"
          onChange={(e) => { const file = e.target.files?.[0]; if (file) void upload(file) }} />
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => fileInput.current?.click()}>
          {operation === "upload" ? <Loader2Icon className="animate-spin" /> : <UploadIcon />}Upload rubric
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={busy || !source.trim()} onClick={() => void extract()}>
          {operation === "extract" ? <Loader2Icon className="animate-spin" /> : <SparklesIcon />}
          {operation === "extract" ? "Extracting criteria…" : criteria.length ? "Replace criteria with AI" : "Extract criteria with AI"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">Word, selectable-text PDF, or plain text. Original files stay in your browser. AI extraction sends this text to the configured providers (Google Gemini or Groq), including a backup if enabled, and replaces the criteria below. It may take up to a minute. Manual entry is also available.</p>
      {criteria.map((criterion, index) => (
        <div key={criterion.id} className="space-y-2 rounded-md border bg-background p-3">
          <div className="flex items-end gap-2">
            <div className="flex-1 space-y-1">
              <Label htmlFor={`criterion-${id}-${index}`}>Criterion {index + 1}</Label>
              <Input id={`criterion-${id}-${index}`} value={criterion.name} maxLength={200} placeholder="Understanding of the topic"
                onChange={(e) => onChange({ criteria: criteria.map((c, i) => i === index ? { ...c, name: e.target.value } : c) })} />
            </div>
            <div className="w-24 space-y-1">
              <Label htmlFor={`limit-${id}-${index}`}>Max points</Label>
              <CriterionPointsInput id={`limit-${id}-${index}`} value={criterion.max_points}
                onChange={(value) => onChange({ criteria: criteria.map((c, i) => i === index ? { ...c, max_points: value } : c) })} />
            </div>
            <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove criterion ${index + 1}`}
              onClick={() => { const remaining = criteria.filter((_, i) => i !== index); onChange(remaining.length ? { criteria: remaining } : null) }}><Trash2Icon /></Button>
          </div>
          <Label htmlFor={`descriptor-${id}-${index}`}>Scoring descriptions</Label>
          <Textarea id={`descriptor-${id}-${index}`} rows={3} maxLength={4000} value={criterion.description}
            placeholder="4: Accurate, complete explanation. 2–3: Mostly correct with omissions. 1: Limited understanding. 0: Missing or incorrect."
            onChange={(e) => onChange({ criteria: criteria.map((c, i) => i === index ? { ...c, description: e.target.value } : c) })} />
          <div className="space-y-2 border-t pt-2">
            <Label htmlFor={`checking-${id}-${index}`}>Automatic checking</Label>
            <Select value={criterion.checking_rule?.mode ?? "manual"} onValueChange={(mode) => {
              onChange({ criteria: criteria.map((c, i) => {
                if (i !== index) return c
                const next = { ...c }
                if (mode === "manual") delete next.checking_rule
                else next.checking_rule = { mode: mode as RubricCheckingRule["mode"], concepts: c.checking_rule?.concepts ?? "" }
                return next
              }) })
            }}>
              <SelectTrigger id={`checking-${id}-${index}`} className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="manual">Manual review only</SelectItem>
                <SelectItem value="all">All concepts required for full points</SelectItem>
                <SelectItem value="any">Any concept earns full points</SelectItem>
                <SelectItem value="proportional">Equal partial points per concept</SelectItem>
              </SelectContent>
            </Select>
            {criterion.checking_rule && <>
              <Label htmlFor={`concepts-${id}-${index}`}>Concepts and accepted phrases</Label>
              <Textarea id={`concepts-${id}-${index}`} rows={4} maxLength={MAX_RULE_TEXT} value={criterion.checking_rule.concepts}
                placeholder={"water | H2O\ncarbon dioxide | CO2\nsunlight | light energy"}
                onChange={(event) => onChange({ criteria: criteria.map((c, i) => i === index ? {
                  ...c, checking_rule: { ...criterion.checking_rule!, concepts: event.target.value },
                } : c) })} />
              <p className="text-xs text-muted-foreground">One concept per line (up to 20). Use | for synonyms. Matching ignores case and punctuation and checks whole words. Repeated mentions count once.</p>
              <p className="text-xs text-muted-foreground">{criterion.checking_rule.mode === "proportional"
                ? "Each concept earns an equal share of this criterion's points; partial scores round down to 0.01."
                : criterion.checking_rule.mode === "all" ? "Full points only when every concept is found; otherwise 0."
                  : "Full points when at least one concept is found; otherwise 0."}</p>
            </>}
            <p className="text-xs text-muted-foreground">Rule checking runs in your browser without AI providers or AI fees. Matches do not prove correctness; teachers review and approve the draft.</p>
          </div>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" size="sm" disabled={criteria.length >= MAX_CRITERIA || busy}
          onClick={() => onChange({ criteria: [...criteria, { id: crypto.randomUUID(), name: "", description: "", max_points: 1 }] })}>
          <PlusIcon />Add criterion
        </Button>
        {rubric && <p className={`text-xs ${Math.abs(rubricTotal(rubric) - points) > 0.000001 ? "text-destructive" : "text-muted-foreground"}`}>
          Rubric total: {rubricTotal(rubric)} / {points} question points. Totals must match.
        </p>}
        {!rubric && <p className="text-xs text-muted-foreground">Without a rubric, the teacher can still approve a manual score.</p>}
      </div>
    </fieldset>
  )
}
