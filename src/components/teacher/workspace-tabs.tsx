"use client"

import { useLayoutEffect, useRef } from "react"
import { Badge } from "@/components/ui/badge"
import { TabsList, TabsTrigger } from "@/components/ui/tabs"

export type WorkspaceTab = "monitor" | "questions" | "settings" | "results"

export function WorkspaceTabs({ value, pendingCount }: { value: WorkspaceTab; pendingCount: number }) {
  const listRef = useRef<HTMLDivElement>(null)
  const indicatorRef = useRef<HTMLSpanElement>(null)

  useLayoutEffect(() => {
    const list = listRef.current
    const indicator = indicatorRef.current
    if (!list || !indicator) return
    let frame = 0
    const measure = () => {
      const active = list.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
      if (!active) return
      const parent = list.getBoundingClientRect()
      const tab = active.getBoundingClientRect()
      if (!tab.width || !tab.height) return
      indicator.style.width = `${tab.width}px`
      indicator.style.height = `${tab.height}px`
      indicator.style.top = `${tab.top - parent.top + list.scrollTop}px`
      indicator.style.transform = `translateX(${tab.left - parent.left + list.scrollLeft}px)`
      indicator.style.opacity = "1"
      // First paint uses the final position; only subsequent changes animate.
      if (!list.dataset.motionReady) {
        cancelAnimationFrame(frame)
        frame = requestAnimationFrame(() => { list.dataset.motionReady = "true" })
      }
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(list)
    list.querySelectorAll('[role="tab"]').forEach((tab) => observer.observe(tab))
    return () => { cancelAnimationFrame(frame); observer.disconnect() }
  }, [value])

  return (
    <TabsList ref={listRef} aria-label="Exam workspace" className="teacher-tabs relative isolate max-w-full justify-start overflow-x-auto overflow-y-hidden">
      <span ref={indicatorRef} aria-hidden="true" className="teacher-tab-indicator" />
      <TabsTrigger value="monitor">Live monitor{pendingCount > 0 && <Badge className="ml-1">{pendingCount}</Badge>}</TabsTrigger>
      <TabsTrigger value="questions">Questions &amp; answer key</TabsTrigger>
      <TabsTrigger value="settings">Settings</TabsTrigger>
      <TabsTrigger value="results">Results</TabsTrigger>
    </TabsList>
  )
}
