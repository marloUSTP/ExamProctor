"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import type { RealtimeChannel } from "@supabase/supabase-js"
import { toast } from "sonner"
import { createClient } from "@/lib/supabase/client"
import { errorMessage } from "@/lib/format"
import type { ExamSession, SessionEvent } from "@/lib/types"

export interface AlertPrefs {
  sound: boolean
  desktop: boolean
}

/** "live": realtime connected. "connecting"/"offline": the dashboard refreshes itself every few seconds instead. */
export type ConnectionStatus = "connecting" | "live" | "offline"

const EVENT_HISTORY = 500
const POLL_WHEN_OFFLINE_MS = 4000
const POLL_WHEN_LIVE_MS = 10000 // safety net in case a realtime message is ever missed

/**
 * Live students + event feed for one exam, kept in sync with Supabase Realtime
 * (with automatic polling whenever realtime isn't connected).
 * Also raises the teacher's notifications (toasts, optional sound / desktop alerts).
 */
export function useExamLive(examId: string, maxViolations: number, prefs: AlertPrefs) {
  const [sessions, setSessions] = useState<ExamSession[]>([])
  const [events, setEvents] = useState<SessionEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState<ConnectionStatus>("connecting")

  const [supabase] = useState(createClient)
  const sessionsRef = useRef<Map<string, ExamSession>>(new Map())
  /** Events already shown/notified, so realtime + polling never notify twice. */
  const seenEvents = useRef<Set<number> | null>(null)
  const settings = useRef({ maxViolations, prefs })
  useEffect(() => {
    settings.current = { maxViolations, prefs }
  })

  const upsertSession = useCallback((row: ExamSession) => {
    sessionsRef.current.set(row.id, row)
    setSessions((prev) => {
      const i = prev.findIndex((s) => s.id === row.id)
      if (i === -1) return [...prev, row]
      const next = prev.slice()
      next[i] = row
      return next
    })
  }, [])

  const removeSession = useCallback((id: string) => {
    sessionsRef.current.delete(id)
    setSessions((prev) => prev.filter((s) => s.id !== id))
    setEvents((prev) => prev.filter((e) => e.session_id !== id))
  }, [])

  // ---- Notifications ----
  const notifyRef = useRef<(event: SessionEvent) => Promise<void>>(async () => {})

  /** Adds new events to the feed (newest first) and notifies about each one exactly once. */
  const receiveEvents = useCallback((incoming: SessionEvent[]) => {
    const seen = seenEvents.current
    if (!seen) return
    const fresh = incoming.filter((e) => !seen.has(e.id)).sort((a, b) => a.id - b.id)
    if (!fresh.length) return
    fresh.forEach((e) => seen.add(e.id))
    setEvents((prev) => [...fresh.slice().reverse(), ...prev].slice(0, EVENT_HISTORY))
    fresh.forEach((e) => void notifyRef.current(e))
  }, [])

  /** Re-reads students and recent events from the database. */
  const refresh = useCallback(async () => {
    const [s, e] = await Promise.all([
      supabase.from("exam_sessions").select("*").eq("exam_id", examId).order("created_at"),
      supabase
        .from("session_events")
        .select("*")
        .eq("exam_id", examId)
        .order("id", { ascending: false })
        .limit(EVENT_HISTORY),
    ])
    if (s.error || e.error) {
      toast.error(errorMessage(s.error ?? e.error), { id: "live-load-error" })
      return
    }
    const rows = (s.data ?? []) as ExamSession[]
    sessionsRef.current = new Map(rows.map((r) => [r.id, r]))
    setSessions(rows)

    const loaded = (e.data ?? []) as SessionEvent[]
    if (!seenEvents.current) {
      // First load: show history without notifying about it.
      seenEvents.current = new Set(loaded.map((x) => x.id))
      setEvents(loaded)
      setLoading(false)
    } else {
      receiveEvents(loaded)
    }
  }, [examId, receiveEvents, supabase])

  const reviewRequest = useCallback(
    async (sessionId: string, approve: boolean) => {
      const { error } = await supabase.rpc("teacher_review_request", { p_session_id: sessionId, p_approve: approve })
      if (error) return toast.error(errorMessage(error))
      toast.dismiss(`join-${sessionId}`)
      await refresh() // don't wait for realtime to update what the teacher just did
    },
    [refresh, supabase]
  )

  useEffect(() => {
    notifyRef.current = async (event: SessionEvent) => {
      let session = sessionsRef.current.get(event.session_id)
      if (!session) {
        // A new student's first event can arrive before their row does.
        const { data } = await supabase.from("exam_sessions").select("*").eq("id", event.session_id).maybeSingle()
        if (data) {
          session = data as ExamSession
          upsertSession(session)
        }
      }
      const name = session?.student_name ?? "A student"
      const { maxViolations: max, prefs } = settings.current
      const count = event.violation_number ? `Violation ${event.violation_number} of ${max}` : undefined

      let title: string
      let body: string | undefined
      let urgent = false

      switch (event.type) {
        case "join_requested":
          title = `${name} wants to join`
          body = session?.student_email
          toast.info(title, {
            id: `join-${event.session_id}`,
            description: body,
            duration: 15000,
            action: { label: "Approve", onClick: () => void reviewRequest(event.session_id, true) },
          })
          break
        case "approved":
        case "rejected":
          toast.dismiss(`join-${event.session_id}`)
          return
        case "left":
          title = `${name} left the exam window`
          body = count
          urgent = true
          toast.error(title, { description: body })
          break
        case "idle":
          title = `${name} is idle`
          body = event.counted ? count : "No activity on the exam page"
          toast.warning(title, { description: body })
          break
        case "auto_submitted":
          title = `${name} was auto-submitted`
          body = event.detail === "time_limit"
            ? "The shared deadline passed. Their answers were saved and graded."
            : `Reached ${max} violations. Their answers were saved and graded.`
          urgent = true
          toast.error(title, { description: body, duration: 10000 })
          break
        case "submitted":
          if (event.detail === "exam_closed") return
          title = `${name} submitted the exam`
          toast.success(title)
          break
        default:
          return // returned / blocked actions etc. only go to the live feed
      }

      if (prefs.sound && urgent) beep()
      if (prefs.desktop && document.hidden && "Notification" in window && Notification.permission === "granted") {
        new Notification(title, { body, tag: `exam-${event.session_id}` })
      }
    }
  }, [reviewRequest, supabase, upsertSession])

  // ---- Realtime subscription ----
  useEffect(() => {
    let cancelled = false
    let channel: RealtimeChannel | null = null

    async function connect() {
      // Realtime checks RLS with the teacher's token.
      const { data: auth } = await supabase.auth.getSession()
      if (cancelled) return
      if (auth.session) await supabase.realtime.setAuth(auth.session.access_token)
      if (cancelled) return

      // A unique topic per mount: the client reuses channels by name, and React (Strict Mode) mounts
      // effects twice in development — reusing the channel being torn down left the dashboard deaf.
      channel = supabase
        .channel(`exam-${examId}-${crypto.randomUUID()}`)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "exam_sessions", filter: `exam_id=eq.${examId}` },
          (payload) => {
            if (payload.eventType === "DELETE") removeSession((payload.old as { id: string }).id)
            else upsertSession(payload.new as ExamSession)
          }
        )
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "session_events", filter: `exam_id=eq.${examId}` },
          (payload) => receiveEvents([payload.new as SessionEvent])
        )
        .subscribe((state, err) => {
          if (cancelled) return
          if (state === "SUBSCRIBED") {
            setStatus("live")
            void refresh() // catch anything that happened while connecting
          } else if (state === "CHANNEL_ERROR" || state === "TIMED_OUT" || state === "CLOSED") {
            if (err) console.warn("Realtime unavailable, falling back to polling:", err.message)
            setStatus("offline")
          }
        })
    }

    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch; state is set after the request returns
    void refresh()
    void connect()
    return () => {
      cancelled = true
      if (channel) void supabase.removeChannel(channel)
    }
  }, [examId, receiveEvents, refresh, removeSession, supabase, upsertSession])

  // ---- Polling: fast while realtime is down, a slow safety net while it's up ----
  useEffect(() => {
    const t = window.setInterval(() => void refresh(), status === "live" ? POLL_WHEN_LIVE_MS : POLL_WHEN_OFFLINE_MS)
    return () => window.clearInterval(t)
  }, [refresh, status])

  return { sessions, events, loading, status, refresh, reviewRequest, removeSession }
}

function beep() {
  try {
    const ctx = new AudioContext()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.frequency.value = 880
    gain.gain.setValueAtTime(0.15, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35)
    osc.connect(gain).connect(ctx.destination)
    osc.start()
    osc.stop(ctx.currentTime + 0.35)
    osc.onended = () => void ctx.close()
  } catch {
    // Audio blocked until the teacher interacts with the page — ignore.
  }
}
