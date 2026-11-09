export function toLocalDateTimeInput(value: string | null | undefined): string {
  if (!value) return ""
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

export function toIsoDateTime(value: string): string | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export function formatCountdown(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  return [hours, minutes, rest].map((value) => String(value).padStart(2, "0")).join(":")
}

/** Anchor each server timestamp once, then advance independently between polls. */
export function createServerCountdown(endAt: string, serverNow: string, now = () => performance.now()): () => number {
  const remainingMs = Date.parse(endAt) - Date.parse(serverNow)
  const receivedAt = now()
  return () => Math.max(0, Math.floor((remainingMs - (now() - receivedAt)) / 1000))
}

export function formatScheduleDate(value: string): string {
  return new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })
}
