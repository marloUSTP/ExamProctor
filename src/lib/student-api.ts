"use client"

import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import type { StudentQuestion, StudentState } from "@/lib/types"

/**
 * Students have no account. They talk to the database only through the
 * student_* functions, identified by the secret token they got when joining.
 */
let client: SupabaseClient | null = null

function db() {
  client ??= createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      auth: { persistSession: false, autoRefreshToken: false },
      // keepalive lets "left the exam" reports finish even while the tab is being hidden or closed.
      global: { fetch: (input, init) => fetch(input, { ...init, keepalive: true }) },
    }
  )
  return client
}

async function call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db().rpc(fn, args)
  if (error) throw error
  return data as T
}

const tokenKey = (code: string) => `exam-proctor:token:${code.toUpperCase()}`

export const studentToken = {
  lastCode(): string | null {
    try {
      const last = localStorage.getItem("exam-proctor:last-code")
      if (last && localStorage.getItem(tokenKey(last))) return last
      // Include sessions saved before the last-code bookmark was introduced.
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i)
        if (key?.startsWith("exam-proctor:token:") && localStorage.getItem(key)) {
          return key.slice("exam-proctor:token:".length)
        }
      }
    } catch {}
    return null
  },
  get(code: string): string | null {
    try {
      return localStorage.getItem(tokenKey(code))
    } catch {
      return null
    }
  },
  set(code: string, token: string) {
    try {
      localStorage.setItem(tokenKey(code), token)
      localStorage.setItem("exam-proctor:last-code", code.toUpperCase())
    } catch {
      // Private mode: the student can still take the exam, but a refresh will lose the session.
    }
  },
  clear(code: string) {
    try {
      localStorage.removeItem(tokenKey(code))
    } catch {}
  },
}

export type ReportType = "left" | "returned" | "idle" | "idle_ended" | "blocked_action" | "screenshot_attempt" | "fullscreen_exit"

export const studentApi = {
  findOrContinue: (code: string, email: string) =>
    call<{ token: string; code: string } | { registration_required: true; code: string }>("student_join", { p_code: code, p_email: email }),
  join: (code: string, email: string, firstName: string, lastName: string) =>
    call<{ token: string; code: string }>("student_join", { p_code: code, p_email: email, p_first_name: firstName, p_last_name: lastName }),
  state: (token: string) => call<StudentState>("student_state", { p_token: token }),
  start: (token: string) => call<StudentState>("student_start", { p_token: token }),
  questions: (token: string) => call<StudentQuestion[]>("student_questions", { p_token: token }),
  saveAnswer: (token: string, questionId: string, answer: string) =>
    call<null>("student_save_answer", { p_token: token, p_question_id: questionId, p_answer: answer }),
  report: (token: string, type: ReportType, detail?: string, durationSeconds?: number) =>
    call<StudentState>("student_report", {
      p_token: token,
      p_type: type,
      p_detail: detail ?? null,
      p_duration: durationSeconds ?? null,
    }),
  submit: (token: string) => call<StudentState>("student_submit", { p_token: token }),
  lookupResult: (code: string, email: string, resultCode: string) =>
    call<StudentState>("student_lookup_result", { p_code: code, p_email: email, p_result_code: resultCode }),
}
