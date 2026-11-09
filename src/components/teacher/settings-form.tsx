"use client"

import { useState } from "react"
import { Loader2Icon, SaveIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { createClient } from "@/lib/supabase/client"
import { errorMessage } from "@/lib/format"
import type { Exam } from "@/lib/types"
import { formatScheduleDate, toIsoDateTime, toLocalDateTimeInput } from "@/lib/schedule"

type Settings = Pick<
  Exam,
  | "title"
  | "instructions"
  | "max_violations"
  | "warn_at"
  | "idle_limit_seconds"
  | "idle_counts_as_violation"
  | "block_copy_paste"
  | "shuffle_questions"
  | "shuffle_choices"
> & { scheduled_start_at: string; scheduled_end_at: string }

const IDLE_OPTIONS = [60, 120, 180, 300, 600]

function pick(exam: Exam): Settings {
  return {
    title: exam.title,
    instructions: exam.instructions,
    max_violations: exam.max_violations,
    warn_at: exam.warn_at,
    idle_limit_seconds: exam.idle_limit_seconds,
    idle_counts_as_violation: exam.idle_counts_as_violation,
    block_copy_paste: exam.block_copy_paste,
    shuffle_questions: exam.shuffle_questions,
    shuffle_choices: exam.shuffle_choices,
    scheduled_start_at: toLocalDateTimeInput(exam.scheduled_start_at),
    scheduled_end_at: toLocalDateTimeInput(exam.scheduled_end_at),
  }
}

function Row({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div className="max-w-xl space-y-0.5">
        <div className="text-sm font-medium">{title}</div>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </div>
  )
}

export function SettingsForm({ exam, onSaved }: { exam: Exam; onSaved: (exam: Exam) => void }) {
  const [form, setForm] = useState<Settings>(() => pick(exam))
  const [saving, setSaving] = useState(false)
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setForm((f) => ({ ...f, [key]: value }))
  const dirty = JSON.stringify(form) !== JSON.stringify(pick(exam))

  function setMax(max: number) {
    // Keep the final warning below the limit (e.g. 4 of 5).
    setForm((f) => ({ ...f, max_violations: max, warn_at: Math.min(f.warn_at, max) }))
  }

  async function save() {
    if (!form.title.trim()) return toast.error("The exam needs a title.")
    if (!!form.scheduled_start_at !== !!form.scheduled_end_at)
      return toast.error("Enter both a scheduled start and end time, or leave both blank.")
    if (
      form.scheduled_start_at &&
      (!toIsoDateTime(form.scheduled_start_at) ||
        !toIsoDateTime(form.scheduled_end_at) ||
        new Date(form.scheduled_end_at) <= new Date(form.scheduled_start_at))
    )
      return toast.error("The scheduled end must be after the start.")
    setSaving(true)
    const payload = {
      ...form,
      scheduled_start_at: toIsoDateTime(form.scheduled_start_at),
      scheduled_end_at: toIsoDateTime(form.scheduled_end_at),
      title: form.title.trim(),
      updated_at: new Date().toISOString(),
    }
    const { data, error } = await createClient()
      .from("exams")
      .update(payload)
      .eq("id", exam.id)
      .select("*")
      .single()
    setSaving(false)
    if (error) return toast.error(errorMessage(error))
    onSaved(data as Exam)
    toast.success(
      exam.status === "open" ? "Settings saved. Students' pages pick up the change within a few seconds." : "Settings saved"
    )
  }

  return (
    <div className="max-w-3xl space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Schedule</CardTitle>
          <CardDescription>
            {exam.scheduled_start_at && exam.scheduled_end_at
              ? `Current window: ${formatScheduleDate(exam.scheduled_start_at)} – ${formatScheduleDate(exam.scheduled_end_at)} (your local time).`
              : "Optional. Set both times to use a shared start and deadline."}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="scheduled-start">Scheduled start</Label>
            <Input id="scheduled-start" type="datetime-local" value={form.scheduled_start_at} onChange={(e) => set("scheduled_start_at", e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="scheduled-end">Shared deadline</Label>
            <Input id="scheduled-end" type="datetime-local" value={form.scheduled_end_at} onChange={(e) => set("scheduled_end_at", e.target.value)} />
          </div>
          <p className="text-sm text-muted-foreground sm:col-span-2">Students may join and wait before the start, but they cannot begin after the shared deadline. Late arrivals get less time.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Exam details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="title">Title</Label>
            <Input id="title" value={form.title} onChange={(e) => set("title", e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="instructions">Instructions for students</Label>
            <Textarea
              id="instructions"
              rows={4}
              value={form.instructions}
              onChange={(e) => set("instructions", e.target.value)}
              placeholder="Shown before the student starts. e.g. Answer all questions. You have 1 hour."
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Anti-cheating</CardTitle>
          <CardDescription>
            Leaving the exam window (Alt+Tab, switching tabs, minimizing) always counts as a violation. The system only
            records that the student left — never which app or website they opened.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <Row
            title={`Auto-submit after ${form.max_violations} violation${form.max_violations === 1 ? "" : "s"}`}
            description="When a student reaches this number, their answers are saved and the exam is submitted automatically."
          >
            <div className="flex w-56 items-center gap-3">
              <Slider
                min={1}
                max={15}
                step={1}
                value={[form.max_violations]}
                onValueChange={([v]) => setMax(v)}
                aria-label="Maximum violations"
              />
              <span className="w-6 text-right tabular-nums">{form.max_violations}</span>
            </div>
          </Row>
          <Row
            title={`Final warning at ${form.warn_at} of ${form.max_violations}`}
            description="The student sees “one more and your exam will be auto-submitted.” Earlier violations show a normal warning."
          >
            <div className="flex w-56 items-center gap-3">
              <Slider
                min={1}
                max={form.max_violations}
                step={1}
                value={[form.warn_at]}
                onValueChange={([v]) => set("warn_at", v)}
                disabled={form.max_violations === 1}
                aria-label="Final warning at"
              />
              <span className="w-6 text-right tabular-nums">{form.warn_at}</span>
            </div>
          </Row>

          <Separator />

          <Row
            title="Idle time limit"
            description="With no mouse, keyboard or touch activity for this long, the student sees “Are you still there?” and you're notified."
          >
            <Select
              value={String(form.idle_limit_seconds)}
              onValueChange={(v) => set("idle_limit_seconds", Number(v))}
            >
              <SelectTrigger className="w-40" aria-label="Idle time limit">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(IDLE_OPTIONS.includes(form.idle_limit_seconds)
                  ? IDLE_OPTIONS
                  : [...IDLE_OPTIONS, form.idle_limit_seconds].sort((a, b) => a - b)
                ).map((s) => (
                  <SelectItem key={s} value={String(s)}>
                    {s % 60 === 0 ? `${s / 60} minute${s === 60 ? "" : "s"}` : `${s} seconds`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
          <Row
            title="Count idle as a violation"
            description="Off: idle is a warning only (recommended — students may just be thinking). On: idle adds 1 to the violation count."
          >
            <Switch
              checked={form.idle_counts_as_violation}
              onCheckedChange={(v) => set("idle_counts_as_violation", v)}
              aria-label="Count idle as a violation"
            />
          </Row>

          <Separator />

          <Row
            title="Block right-click, copy and paste"
            description="Also blocks view-source, print and dev-tools shortcuts. Attempts appear in the activity log but never count as violations."
          >
            <Switch
              checked={form.block_copy_paste}
              onCheckedChange={(v) => set("block_copy_paste", v)}
              aria-label="Block right-click, copy and paste"
            />
          </Row>

          <Separator />

          <Row
            title="Shuffle question order"
            description="Each student gets the questions in a different order, so neighbours can't follow along."
          >
            <Switch
              checked={form.shuffle_questions}
              onCheckedChange={(v) => set("shuffle_questions", v)}
              aria-label="Shuffle question order"
            />
          </Row>
          <Row
            title="Shuffle multiple-choice options"
            description="Each student sees the choices (A, B, C, D) in a different order. Grading still uses your answer key."
          >
            <Switch
              checked={form.shuffle_choices}
              onCheckedChange={(v) => set("shuffle_choices", v)}
              aria-label="Shuffle multiple-choice options"
            />
          </Row>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Results</CardTitle>
          <CardDescription>Students can review their own responses after submitting. Correct answers and per-question points unlock when the exam ends or when you release scores. Submissions awaiting essay grading show a partial score until all essays are approved.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <p className="text-sm text-muted-foreground">Results appear automatically after the shared deadline or when you close the exam. You can also release them early from the Results tab. Hiding scores conceals them again.</p>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={save} disabled={!dirty || saving}>
          {saving ? <Loader2Icon className="animate-spin" /> : <SaveIcon />}
          Save settings
        </Button>
      </div>
    </div>
  )
}
