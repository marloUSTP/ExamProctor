"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { AnswerAutosave, createAnswerDraftStore, type AnswerSaveState } from "@/lib/answer-autosave"
import { errorMessage } from "@/lib/format"
import { studentApi } from "@/lib/student-api"
import type { StudentQuestion } from "@/lib/types"

export function useExamAnswers(token: string, startedAt: string | null) {
  const [questions, setQuestions] = useState<StudentQuestion[] | null>(null)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [saveState, setSaveState] = useState<AnswerSaveState>({ status: "saved", locallySaved: false })
  const [loadError, setLoadError] = useState<string | null>(null)
  const autosave = useRef<AnswerAutosave | null>(null)

  useEffect(() => {
    let cancelled = false
    let loading = false
    let retry: ReturnType<typeof setTimeout> | undefined
    let saver: AnswerAutosave | null = null

    async function load() {
      if (cancelled || loading || saver) return
      loading = true
      clearTimeout(retry)
      try {
        // Validate the attempt with the server before replaying any local drafts.
        const qs = await studentApi.questions(token)
        if (cancelled) return
        saver = new AnswerAutosave((id, value) => studentApi.saveAnswer(token, id, value), createAnswerDraftStore(token, startedAt), setSaveState)
        autosave.current = saver
        setAnswers(saver.restore(Object.fromEntries(qs.map((q) => [q.id, q.answer ?? ""]))))
        setQuestions(qs)
        setLoadError(null)
        void saver.flush()
      } catch (err) {
        if (!cancelled) {
          setLoadError(errorMessage(err))
          retry = setTimeout(() => void load(), 3000)
        }
      } finally {
        loading = false
      }
    }

    const onOnline = () => {
      if (saver) void saver.flush()
      else void load()
    }
    window.addEventListener("online", onOnline)
    void load()
    return () => {
      cancelled = true
      clearTimeout(retry)
      window.removeEventListener("online", onOnline)
      saver?.dispose()
      autosave.current = null
    }
  }, [token, startedAt])

  const setAnswer = useCallback((id: string, value: string, delay = 0) => {
    if (!autosave.current) return
    autosave.current.setAnswer(id, value, delay)
    setAnswers((previous) => ({ ...previous, [id]: value }))
  }, [])

  const flush = useCallback(() => autosave.current?.flush() ?? Promise.resolve(false), [])

  return { questions, answers, saveState, loadError, setAnswer, flush }
}
