import type { SupabaseClient } from "@supabase/supabase-js"
import { buildEssayQueue, queueableEssayQuestions, type QueueAnswer, type QueueSuggestion } from "./essay-queue"
import type { ExamSession, Question } from "./types"

/** Paginate both tables: Supabase's default row cap must not hide existing approvals/drafts. */
export async function loadEssayQueue(client: SupabaseClient, questions: Question[], sessions: ExamSession[], cancelled = () => false) {
  const essays = queueableEssayQuestions(questions)
  const finished = sessions.filter((session) => ["submitted", "auto_submitted"].includes(session.status))
  const answers: QueueAnswer[] = []
  const suggestions: QueueSuggestion[] = []
  for (let offset = 0; offset < finished.length && essays.length; offset += 50) {
    if (cancelled()) throw new Error("Queue preparation stopped.")
    const ids = finished.slice(offset, offset + 50).map((session) => session.id)
    const questionIds = essays.map((question) => question.id)
    async function read(table: "answers" | "essay_suggestions", fields: string) {
      const rows: unknown[] = []
      for (let page = 0; ; page++) {
        if (cancelled()) throw new Error("Queue preparation stopped.")
        let query = client.from(table).select(fields).in("session_id", ids).in("question_id", questionIds)
        if (table === "essay_suggestions") query = query.is("approved_at", null)
        query = query.order("session_id").order("question_id")
        if (table === "essay_suggestions") query = query.order("id")
        const { data, error } = await query.range(page * 500, page * 500 + 499)
        if (error) throw error
        rows.push(...(data ?? []))
        if (!data || data.length < 500) return rows
      }
    }
    const results = await Promise.allSettled([
      read("answers", "session_id,question_id,answer,overridden,approval_snapshot"),
      read("essay_suggestions", "session_id,question_id,attempt,answer_snapshot,question_snapshot,approved_at"),
    ])
    for (const result of results) if (result.status === "rejected") throw result.reason
    if (results[0].status === "fulfilled") answers.push(...results[0].value as QueueAnswer[])
    if (results[1].status === "fulfilled") suggestions.push(...results[1].value as QueueSuggestion[])
  }
  if (cancelled()) throw new Error("Queue preparation stopped.")
  return buildEssayQueue(essays, finished, answers, suggestions)
}
