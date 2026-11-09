import Link from "next/link"
import { ClipboardListIcon, FileQuestionIcon, UsersIcon } from "lucide-react"
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { ExamActionsMenu } from "@/components/teacher/exam-actions-menu"
import { ExamStatusBadge } from "@/components/teacher/exam-status-badge"
import { NewExamButton } from "@/components/teacher/new-exam-button"
import { createClient } from "@/lib/supabase/server"
import type { Exam } from "@/lib/types"

type ExamRow = Exam & { questions: { count: number }[]; exam_sessions: { count: number }[] }

export default async function TeacherHome() {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("exams")
    .select("*, questions(count), exam_sessions(count)")
    .order("created_at", { ascending: false })
  const allExams = (data ?? []) as ExamRow[]
  const exams = allExams.filter((exam) => !exam.is_archived)
  const archivedExams = allExams.filter((exam) => exam.is_archived)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Your exams</h1>
          <p className="text-sm text-muted-foreground">Create an exam, open it, and share the code with your students.</p>
        </div>
        <NewExamButton />
      </div>

      {error && <p className="text-sm text-destructive">Couldn&apos;t load exams: {error.message}</p>}

      {exams.length === 0 && !error ? (
        <Card className="items-center py-16 text-center">
          <ClipboardListIcon className="size-8 text-muted-foreground" />
          <CardHeader className="w-full">
            <CardTitle>No exams yet</CardTitle>
            <CardDescription>Click “New exam” to create your first one.</CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {exams.map((exam) => (
            <div key={exam.id} className="relative">
              <Link href={`/teacher/exams/${exam.id}`} className="group block h-full">
                <Card className="h-full transition-shadow group-hover:ring-foreground/30">
                  <CardHeader>
                    <div className="flex items-start justify-between gap-2">
                      <CardTitle className="line-clamp-2">{exam.title}</CardTitle>
                      <ExamStatusBadge status={exam.status} scheduled={!!exam.scheduled_start_at && !!exam.scheduled_end_at} />
                    </div>
                    <CardDescription className="font-mono">Code: {exam.code}</CardDescription>
                  </CardHeader>
                  <CardFooter className="mt-auto gap-4 pr-14 text-sm text-muted-foreground">
                    <span className="flex items-center gap-1.5">
                      <FileQuestionIcon className="size-4" />
                      {exam.questions[0]?.count ?? 0} questions
                    </span>
                    <span className="flex items-center gap-1.5">
                      <UsersIcon className="size-4" />
                      {exam.exam_sessions[0]?.count ?? 0} students
                    </span>
                  </CardFooter>
                </Card>
              </Link>
              {/* Outside the link so opening the menu doesn't open the exam */}
              <div className="absolute right-3 bottom-2">
                <ExamActionsMenu examId={exam.id} title={exam.title} />
              </div>
            </div>
          ))}
        </div>
      )}

      {archivedExams.length > 0 && (
        <section className="space-y-4 border-t pt-6">
          <div>
            <h2 className="text-lg font-semibold">Archived exams</h2>
            <p className="text-sm text-muted-foreground">Archived exams are closed to students. Restore one from its actions menu.</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {archivedExams.map((exam) => (
              <div key={exam.id} className="relative">
                <Link href={`/teacher/exams/${exam.id}`} className="group block h-full">
                  <Card className="h-full opacity-75 transition-shadow group-hover:ring-foreground/30">
                    <CardHeader>
                      <div className="flex items-start justify-between gap-2">
                        <CardTitle className="line-clamp-2">{exam.title}</CardTitle>
                        <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">Archived</span>
                      </div>
                      <CardDescription className="font-mono">Code: {exam.code}</CardDescription>
                    </CardHeader>
                    <CardFooter className="mt-auto gap-4 pr-14 text-sm text-muted-foreground">
                      <span className="flex items-center gap-1.5"><FileQuestionIcon className="size-4" />{exam.questions[0]?.count ?? 0} questions</span>
                      <span className="flex items-center gap-1.5"><UsersIcon className="size-4" />{exam.exam_sessions[0]?.count ?? 0} students</span>
                    </CardFooter>
                  </Card>
                </Link>
                <div className="absolute right-3 bottom-2">
                  <ExamActionsMenu examId={exam.id} title={exam.title} archived />
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
