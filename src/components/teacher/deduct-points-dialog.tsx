"use client"

import { useCallback, useEffect, useState } from "react"
import { MinusCircleIcon, Undo2Icon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { createClient } from "@/lib/supabase/client"
import { errorMessage, formatTime } from "@/lib/format"
import type { ExamSession, SessionEvent } from "@/lib/types"

/**
 * Deductions that still count for the student's current attempt: made after the
 * last retake and not undone. Read straight from the database because the live
 * feed only keeps recent events.
 */
async function loadActiveDeductions(sessionId: string): Promise<SessionEvent[]> {
  const { data, error } = await createClient()
    .from("session_events")
    .select("*")
    .eq("session_id", sessionId)
    .in("type", ["points_deducted", "deduction_undone", "retake_allowed"])
    .order("id")
  if (error) throw error
  const events = (data ?? []) as SessionEvent[]
  const lastRetake = Math.max(0, ...events.filter((e) => e.type === "retake_allowed").map((e) => e.id))
  const undone = new Set(events.filter((e) => e.type === "deduction_undone").map((e) => e.detail))
  return events.filter((e) => e.type === "points_deducted" && e.id > lastRetake && !undone.has(String(e.id)))
}

/** Takes points off a student's score, or gives back an earlier deduction. Used on the live monitor and results tab. */
export function DeductPointsDialog({
  session,
  onClose,
  onDeducted,
}: {
  session: ExamSession | null
  onClose: () => void
  onDeducted: () => Promise<void>
}) {
  const [points, setPoints] = useState("")
  const [reason, setReason] = useState("")
  const [saving, setSaving] = useState(false)
  const [openFor, setOpenFor] = useState<string | null>(null)
  const [deductions, setDeductions] = useState<SessionEvent[] | null>(null)
  const [undoing, setUndoing] = useState<number | null>(null)

  // Start empty each time the dialog opens for a student.
  if (session && session.id !== openFor) {
    setOpenFor(session.id)
    setPoints("")
    setReason("")
    setDeductions(null)
  } else if (!session && openFor !== null) {
    setOpenFor(null)
  }

  const reload = useCallback(async (sessionId: string) => {
    try {
      setDeductions(await loadActiveDeductions(sessionId))
    } catch (error) {
      toast.error(errorMessage(error))
      setDeductions([])
    }
  }, [])

  useEffect(() => {
    if (openFor) loadActiveDeductions(openFor).then(setDeductions, () => setDeductions([]))
  }, [openFor])

  const value = Number(points)
  const valid = points.trim() !== "" && Number.isFinite(value) && value > 0
  const finished = session?.status === "submitted" || session?.status === "auto_submitted"

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!session || !valid) return
    setSaving(true)
    const { error } = await createClient().rpc("teacher_deduct_points", {
      p_session_id: session.id,
      p_points: value,
      p_reason: reason.trim(),
    })
    setSaving(false)
    if (error) return toast.error(errorMessage(error))
    toast.success(`Deducted ${value} point${value === 1 ? "" : "s"} from ${session.student_name}`)
    onClose()
    await onDeducted()
  }

  async function undo(event: SessionEvent) {
    if (!session) return
    setUndoing(event.id)
    const { error } = await createClient().rpc("teacher_undo_deduction", { p_event_id: event.id })
    setUndoing(null)
    if (error) return toast.error(errorMessage(error))
    const pts = Number(event.points)
    toast.success(`Gave back ${pts} point${pts === 1 ? "" : "s"} to ${session.student_name}`)
    await Promise.all([reload(session.id), onDeducted()])
  }

  return (
    <Dialog open={!!session} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Deduct points from {session?.student_name}</DialogTitle>
            <DialogDescription>
              {finished
                ? `Their score (${session?.score ?? 0}/${session?.max_score ?? 0}) is lowered right away.`
                : "The points come off their score when the exam is submitted."}{" "}
              The score never goes below 0, and the deduction is recorded in the activity log.
            </DialogDescription>
          </DialogHeader>

          {deductions && deductions.length > 0 && (
            <div className="space-y-2">
              <Label>Current deductions</Label>
              <ul className="divide-y rounded-lg border">
                {deductions.map((d) => (
                  <li key={d.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                    <div className="min-w-0">
                      <div className="font-medium text-destructive">−{Number(d.points)} pts</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {d.detail ? `${d.detail} · ` : ""}
                        {formatTime(d.created_at)}
                      </div>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={undoing !== null}
                      onClick={() => undo(d)}
                    >
                      <Undo2Icon />
                      {undoing === d.id ? "Undoing…" : "Undo"}
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="deduct-points">Points to deduct</Label>
            <Input
              id="deduct-points"
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
              value={points}
              onChange={(e) => setPoints(e.target.value)}
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="deduct-reason">Reason (optional)</Label>
            <Textarea
              id="deduct-reason"
              placeholder="e.g. Caught looking at a phone"
              maxLength={200}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={!valid || saving}>
              <MinusCircleIcon />
              {saving ? "Deducting…" : "Deduct points"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
