import type { ExamSession, QuestionType, SessionEvent } from "@/lib/types"

/** A student whose page hasn't checked in for this long is shown as disconnected. */
export const DISCONNECTED_AFTER_MS = 30_000

export function formatDuration(totalSeconds: number | null | undefined): string {
  const s = Math.max(0, Math.round(totalSeconds ?? 0))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rest = s % 60
  if (m < 60) return rest ? `${m}m ${rest}s` : `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

export const QUESTION_TYPE_LABEL: Record<QuestionType, string> = {
  multiple_choice: "Multiple choice",
  true_false: "True / False",
  identification: "Identification",
  essay: "Essay",
}

const BLOCKED_LABEL: Record<string, string> = {
  right_click: "right-click",
  copy: "copying text",
  cut: "cutting text",
  paste: "pasting text",
  shortcut: "a blocked keyboard shortcut",
}

/** One-line description of an event for the teacher's timeline and notifications. */
export function describeEvent(event: SessionEvent, maxViolations: number): string {
  const count = event.counted && event.violation_number ? ` (violation ${event.violation_number}/${maxViolations})` : ""
  switch (event.type) {
    case "join_requested":
      return "Asked to join the exam"
    case "approved":
      return "Approved to take the exam"
    case "rejected":
      return "Request was rejected"
    case "started":
      return "Started the exam"
    case "left":
      return `Left the exam window${count}`
    case "returned":
      return `Came back after ${formatDuration(event.duration_seconds)}`
    case "idle":
      return `Became idle${count}`
    case "idle_ended":
      return `Active again after ${formatDuration(event.duration_seconds)} idle`
    case "blocked_action":
      return `Tried ${BLOCKED_LABEL[event.detail ?? ""] ?? "a blocked action"} (blocked)`
    case "screenshot_attempt":
      return `Attempted a screenshot${count}`
    case "fullscreen_exit":
      return "Exited fullscreen"
    case "submitted":
      if (event.detail === "exam_closed") return "Submitted when the exam was closed"
      if (event.detail === "teacher") return "Submitted by the teacher"
      return "Submitted the exam"
    case "auto_submitted":
      return event.detail === "time_limit" ? "Auto-submitted: shared deadline reached" : "Auto-submitted: reached the violation limit"
    case "retake_allowed":
      return `Allowed to retake the exam (attempt ${event.detail ?? "2"})`
    case "points_deducted": {
      const pts = Number(event.points ?? 0)
      const label = `Lost ${pts} point${pts === 1 ? "" : "s"} (deducted by the teacher)`
      return event.detail ? `${label}: ${event.detail}` : label
    }
    case "deduction_undone": {
      const pts = Number(event.points ?? 0)
      return `Got back ${pts} deducted point${pts === 1 ? "" : "s"} (undone by the teacher)`
    }
  }
}

export type LiveStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "active"
  | "away"
  | "idle"
  | "disconnected"
  | "submitted"
  | "auto_submitted"

export function liveStatus(session: ExamSession, now: number): LiveStatus {
  if (session.status !== "in_progress") return session.status
  if (now - new Date(session.last_seen_at).getTime() > DISCONNECTED_AFTER_MS) return "disconnected"
  return session.activity
}

export const LIVE_STATUS_META: Record<LiveStatus, { label: string; dot: string }> = {
  pending: { label: "Waiting for approval", dot: "bg-amber-500" },
  approved: { label: "Approved, not started", dot: "bg-sky-500" },
  rejected: { label: "Rejected", dot: "bg-muted-foreground" },
  active: { label: "Active", dot: "bg-emerald-500" },
  away: { label: "Away", dot: "bg-red-500" },
  idle: { label: "Idle", dot: "bg-amber-500" },
  disconnected: { label: "Disconnected", dot: "bg-zinc-500" },
  submitted: { label: "Submitted", dot: "bg-emerald-600" },
  auto_submitted: { label: "Auto-submitted", dot: "bg-red-600" },
}

/** Supabase RPC errors carry our codes (e.g. EXAM_NOT_OPEN) in `message` and the friendly text in `hint`. */
export function errorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const e = error as { message?: string; hint?: string }
    if (e.hint) return e.hint
    const known: Record<string, string> = {
      EXAM_NOT_FOUND: "No exam matches that code.",
      EXAM_NOT_OPEN: "This exam is not open right now.",
      INVALID_TOKEN: "Your exam session was not found. Please join again.",
      NOT_APPROVED: "Your teacher hasn't approved you yet.",
      NOT_IN_PROGRESS: "This exam is no longer in progress.",
      FORBIDDEN: "You don't have access to that.",
    }
    if (e.message && known[e.message]) return known[e.message]
    if (e.message) return e.message
  }
  return "Something went wrong. Please try again."
}
