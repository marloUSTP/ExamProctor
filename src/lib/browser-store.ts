"use client"

import { useSyncExternalStore } from "react"

const noopSubscribe = () => () => {}

/**
 * Reads a browser-only value (localStorage etc.) without a hydration mismatch:
 * the server render and first client render get `serverValue`, then the real value.
 */
export function useBrowserValue<T, S>(read: () => T, serverValue: S): T | S {
  return useSyncExternalStore<T | S>(noopSubscribe, read, () => serverValue)
}

function subscribeFullscreen(onChange: () => void) {
  document.addEventListener("fullscreenchange", onChange)
  return () => document.removeEventListener("fullscreenchange", onChange)
}

/** True when the browser supports fullscreen and the page is not currently fullscreen. */
export function useOutOfFullscreen(): boolean {
  return useSyncExternalStore(
    subscribeFullscreen,
    () => document.fullscreenEnabled && !document.fullscreenElement,
    () => false
  )
}

/** A small JSON value persisted in localStorage and shared by every component that reads it. */
export function createStoredValue<T>(key: string, fallback: T) {
  const listeners = new Set<() => void>()
  let cachedRaw: string | null | undefined
  let cachedValue: T = fallback

  function get(): T {
    let raw: string | null = null
    try {
      raw = localStorage.getItem(key)
    } catch {}
    if (raw !== cachedRaw) {
      cachedRaw = raw
      try {
        cachedValue = raw ? { ...fallback, ...JSON.parse(raw) } : fallback
      } catch {
        cachedValue = fallback
      }
    }
    return cachedValue
  }

  function set(value: T) {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {}
    listeners.forEach((l) => l())
  }

  function subscribe(listener: () => void) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  function useValue(): T {
    return useSyncExternalStore(subscribe, get, () => fallback)
  }

  return { useValue, set }
}
