import { notFound } from "next/navigation"
import { ExamWorkspace, type WorkspaceTab } from "@/components/teacher/exam-workspace"
import { createClient } from "@/lib/supabase/server"
import type { Exam, Question } from "@/lib/types"

const TABS: WorkspaceTab[] = ["monitor", "questions", "settings", "results"]

export default async function ExamPage({ params, searchParams }: PageProps<"/teacher/exams/[id]">) {
  const { id } = await params
  const { tab } = await searchParams
  const supabase = await createClient()

  const [{ data: exam }, { data: questions }] = await Promise.all([
    supabase.from("exams").select("*").eq("id", id).maybeSingle(),
    supabase.from("questions").select("*").eq("exam_id", id).order("position").order("created_at"),
  ])
  if (!exam) notFound()

  const initialTab = TABS.includes(tab as WorkspaceTab) ? (tab as WorkspaceTab) : "monitor"

  return (
    <ExamWorkspace
      // A fresh workspace per exam (e.g. after "Duplicate"), not the previous exam's state
      key={id}
      initialExam={exam as Exam}
      initialQuestions={(questions ?? []) as Question[]}
      initialTab={initialTab}
    />
  )
}
