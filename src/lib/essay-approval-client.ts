import type { SupabaseClient } from "@supabase/supabase-js"
import { buildEssayApprovals, type ApprovalAnswer, type ApprovalSession } from "./essay-approval"
import type { EssaySuggestion, Question } from "./types"

export async function loadEssayApprovals(client: SupabaseClient, questions: Question[], sessions: ApprovalSession[], cancelled = () => false) {
  const essays = questions.filter((q) => q.type === "essay" && q.rubric)
  const finished = sessions.filter((s) => ["submitted", "auto_submitted"].includes(s.status))
  const answers: ApprovalAnswer[] = []
  const suggestions: EssaySuggestion[] = []
  for (let offset = 0; offset < finished.length && essays.length; offset += 50) {
    const ids = finished.slice(offset, offset + 50).map((s) => s.id)
    async function read(table: "answers" | "essay_suggestions", fields: string) {
      const rows: unknown[] = []
      for (let page = 0; ; page++) {
        if (cancelled()) throw new Error("Checklist loading stopped.")
        let query = client.from(table).select(fields).in("session_id", ids).in("question_id", essays.map((q) => q.id))
        if (table === "essay_suggestions") query = query.is("approved_at", null)
        query = query.order("session_id").order("question_id")
        if (table === "essay_suggestions") query = query.order("id")
        const { data, error } = await query.range(page * 500, page * 500 + 499)
        if (error) throw error
        rows.push(...(data ?? []))
        if (!data || data.length < 500) return rows
      }
    }
    const rows = await Promise.allSettled([
      read("answers", "session_id,question_id,answer,overridden,approval_snapshot,points_awarded,rubric_grading"),
      read("essay_suggestions", "*"),
    ])
    for (const result of rows) if (result.status === "rejected") throw result.reason
    if (rows[0].status === "fulfilled") answers.push(...rows[0].value as ApprovalAnswer[])
    if (rows[1].status === "fulfilled") suggestions.push(...rows[1].value as EssaySuggestion[])
  }
  if (cancelled()) throw new Error("Checklist loading stopped.")
  return buildEssayApprovals(essays, finished, answers, suggestions)
}
