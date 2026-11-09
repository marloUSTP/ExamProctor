"use client"

import { useEffect, useRef } from "react"
import type { BlockedAction } from "@/lib/types"

export interface ProctoringOptions {
  enabled: boolean
  idleLimitSeconds: number
  blockCopyPaste: boolean
  /** Alt+Tab, switched tab, minimized, or clicked another window. */
  onLeave: () => void
  onReturn: (awaySeconds: number) => void
  onIdle: () => void
  onIdleEnd: (idleSeconds: number) => void
  onBlocked: (action: BlockedAction) => void
  onScreenshot: () => void
}

const ACTIVITY_EVENTS = ["mousemove", "mousedown", "keydown", "wheel", "touchstart", "scroll"] as const

function isEditable(target: EventTarget | null) {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA)$/.test(target.tagName))
}

/**
 * Watches the exam page. The browser never tells us *where* the student went,
 * only that the exam lost focus — which is all we record.
 */
export function useProctoring(options: ProctoringOptions) {
  // Latest callbacks without re-binding listeners on every render.
  const opts = useRef(options)
  useEffect(() => {
    opts.current = options
  })

  const { enabled, idleLimitSeconds, blockCopyPaste } = options

  // Only browser-visible screenshot key events can be detected. OS/mobile gestures may not reach the page.
  useEffect(() => {
    if (!enabled) return
    const onKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase()
      const screenshot = e.key === "PrintScreen" || ((e.metaKey || e.ctrlKey) && e.shiftKey && ["3", "4", "5"].includes(key))
      if (!screenshot) return
      e.preventDefault()
      opts.current.onScreenshot()
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [enabled])

  // ---- Leaving the exam (Alt+Tab, tab switch, minimize) ----
  useEffect(() => {
    if (!enabled) return
    let awaySince: number | null = null

    const check = () => {
      const away = document.hidden || !document.hasFocus()
      if (away && awaySince === null) {
        awaySince = Date.now()
        opts.current.onLeave()
      } else if (!away && awaySince !== null) {
        const seconds = (Date.now() - awaySince) / 1000
        awaySince = null
        opts.current.onReturn(seconds)
      }
    }

    // blur and visibilitychange usually fire together; `check` reports each departure once.
    window.addEventListener("blur", check)
    window.addEventListener("focus", check)
    document.addEventListener("visibilitychange", check)
    check()
    return () => {
      window.removeEventListener("blur", check)
      window.removeEventListener("focus", check)
      document.removeEventListener("visibilitychange", check)
    }
  }, [enabled])

  // ---- Idle: no mouse / keyboard / touch activity for the teacher's limit ----
  useEffect(() => {
    if (!enabled) return
    let lastActivity = Date.now()
    let idleSince: number | null = null

    const onActivity = () => {
      lastActivity = Date.now()
      if (idleSince !== null) {
        const seconds = (Date.now() - idleSince) / 1000 + idleLimitSeconds
        idleSince = null
        opts.current.onIdleEnd(seconds)
      }
    }

    const timer = window.setInterval(() => {
      // Being away is already reported; don't double-report it as idle.
      if (document.hidden || !document.hasFocus()) {
        lastActivity = Date.now()
        return
      }
      if (idleSince === null && Date.now() - lastActivity >= idleLimitSeconds * 1000) {
        idleSince = Date.now()
        opts.current.onIdle()
      }
    }, 1000)

    ACTIVITY_EVENTS.forEach((e) => window.addEventListener(e, onActivity, { passive: true, capture: true }))
    return () => {
      window.clearInterval(timer)
      ACTIVITY_EVENTS.forEach((e) => window.removeEventListener(e, onActivity, { capture: true }))
    }
  }, [enabled, idleLimitSeconds])

  // ---- Block right-click, copy / cut / paste and common shortcuts (logged, never a violation) ----
  useEffect(() => {
    if (!enabled || !blockCopyPaste) return

    const block = (action: BlockedAction) => (e: Event) => {
      e.preventDefault()
      opts.current.onBlocked(action)
    }
    const onContextMenu = block("right_click")
    const onCopy = block("copy")
    const onCut = block("cut")
    const onPaste = block("paste")

    const onKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase()
      const mod = e.ctrlKey || e.metaKey
      const blocked =
        e.key === "F12" ||
        (mod && e.shiftKey && ["i", "j", "c"].includes(key)) || // dev tools
        (mod && ["u", "p", "s"].includes(key)) || // view source, print, save
        (mod && key === "a" && !isEditable(e.target)) // select the whole page
      // Ctrl+C / Ctrl+V / Ctrl+X are caught by the copy/paste/cut listeners above.
      if (blocked) {
        e.preventDefault()
        opts.current.onBlocked("shortcut")
      }
    }

    document.addEventListener("contextmenu", onContextMenu)
    document.addEventListener("copy", onCopy)
    document.addEventListener("cut", onCut)
    document.addEventListener("paste", onPaste)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("contextmenu", onContextMenu)
      document.removeEventListener("copy", onCopy)
      document.removeEventListener("cut", onCut)
      document.removeEventListener("paste", onPaste)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [enabled, blockCopyPaste])
}
