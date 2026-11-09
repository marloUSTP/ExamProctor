"use client"

import Link from "next/link"
import { useState } from "react"
import { ArrowLeftIcon, CopyIcon, DoorClosedIcon, DoorOpenIcon, Link2Icon } from "lucide-react"
import { toast } from "sonner"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent } from "@/components/ui/tabs"
import { WorkspaceTabs, type WorkspaceTab } from "@/components/teacher/workspace-tabs"
import { ExamActionsMenu } from "@/components/teacher/exam-actions-menu"
import { ExamStatusBadge } from "@/components/teacher/exam-status-badge"
import { LiveMonitor } from "@/components/teacher/live-monitor"
import { QuestionsEditor } from "@/components/teacher/questions-editor"
import { ResultsPanel } from "@/components/teacher/results-panel"
import { SettingsForm } from "@/components/teacher/settings-form"
import { useExamLive, type AlertPrefs } from "@/hooks/use-exam-live"
import { createStoredValue } from "@/lib/browser-store"
import { createClient } from "@/lib/supabase/client"
import { errorMessage } from "@/lib/format"
import type { Exam, Question } from "@/lib/types"
import { formatScheduleDate } from "@/lib/schedule"

export type { WorkspaceTab } from "@/components/teacher/workspace-tabs"

const alertPrefs = createStoredValue<AlertPrefs>("exam-proctor:alert-prefs", { sound: true, desktop: false })

export function ExamWorkspace({
  initialExam,
  initialQuestions,
  initialTab,
}: {
  initialExam: Exam
  initialQuestions: Question[]
  initialTab: WorkspaceTab
}) {
  const [exam, setExam] = useState(initialExam)
  const [questions, setQuestions] = useState(initialQuestions)
  const [tab, setTab] = useState<WorkspaceTab>(initialTab)
  const [resultsVisited, setResultsVisited] = useState(initialTab === "results")
  const prefs = alertPrefs.useValue()

  // Subscribed here (not inside the Monitor tab) so notifications arrive on every tab.
  const live = useExamLive(exam.id, exam.max_violations, prefs)
  const pendingCount = live.sessions.filter((s) => s.status === "pending").length

  function changeTab(value: string) {
    if (value === "results") setResultsVisited(true)
    setTab(value as WorkspaceTab)
    const url = new URL(window.location.href)
    url.searchParams.set("tab", value)
    window.history.replaceState(null, "", url)
  }

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(`${what} copied`)
    } catch {
      toast.error("Couldn't copy — select it manually.")
    }
  }

  async function setStatus(status: "open" | "closed") {
    const supabase = createClient()
    if (status === "open") {
      if (exam.is_archived) {
        toast.error("Restore this archived exam before opening it.")
        return
      }
      if (questions.length === 0) {
        toast.error("Add and save at least one question before opening the exam.")
        changeTab("questions")
        return
      }
      const { error } = await supabase.from("exams").update({ status: "open", updated_at: new Date().toISOString() }).eq("id", exam.id)
      if (error) return toast.error(errorMessage(error))
      toast.success("Exam is open. Students can now join with the code.")
    } else {
      const { error } = await supabase.rpc("teacher_close_exam", { p_exam_id: exam.id })
      if (error) return toast.error(errorMessage(error))
      toast.success("Exam closed. Students still answering were submitted automatically.")
    }
    setExam((e) => ({ ...e, status }))
  }

  const joinLink = typeof window === "undefined" ? "" : `${window.location.origin}/join?code=${exam.code}`

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/teacher">
            <ArrowLeftIcon />
            All exams
          </Link>
        </Button>

        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">{exam.title}</h1>
              <ExamStatusBadge status={exam.status} scheduled={!!exam.scheduled_start_at && !!exam.scheduled_end_at} />
            </div>
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span>Exam code</span>
              <button
                type="button"
                onClick={() => copy(exam.code, "Exam code")}
                className="inline-flex items-center gap-1.5 rounded-md border bg-muted px-2 py-0.5 font-mono text-base font-semibold tracking-widest text-foreground hover:bg-muted/70"
              >
                {exam.code}
                <CopyIcon className="size-3.5 text-muted-foreground" />
              </button>
              <Button variant="ghost" size="sm" onClick={() => copy(joinLink, "Join link")}>
                <Link2Icon />
                Copy join link
              </Button>
            </div>
            {exam.scheduled_start_at && exam.scheduled_end_at && (
              <p className="text-sm text-muted-foreground">
                Scheduled: {formatScheduleDate(exam.scheduled_start_at)} – {formatScheduleDate(exam.scheduled_end_at)}
              </p>
            )}
          </div>

          <div className="flex gap-2">
            {exam.is_archived ? (
              <span className="self-center text-sm text-muted-foreground">Archived · closed to students</span>
            ) : exam.status === "open" ? (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="destructive">
                    <DoorClosedIcon />
                    Close exam
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Close this exam?</AlertDialogTitle>
                    <AlertDialogDescription>
                      No one else can join, and every student who is still answering will be submitted and graded
                      with the answers they have so far.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction variant="destructive" onClick={() => setStatus("closed")}>
                      Close exam
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            ) : (
              <Button onClick={() => setStatus("open")}>
                <DoorOpenIcon />
                {exam.status === "draft" ? "Open exam" : "Reopen exam"}
              </Button>
            )}
            <ExamActionsMenu
              examId={exam.id}
              title={exam.title}
              archived={exam.is_archived}
              onArchiveChange={(is_archived) => setExam((current) => ({ ...current, is_archived, status: "closed" }))}
            />
          </div>
        </div>
      </div>

      <Tabs value={tab} onValueChange={changeTab}>
        <WorkspaceTabs value={tab} pendingCount={pendingCount} />

        <TabsContent value="monitor" className="teacher-panel mt-4">
          <LiveMonitor exam={exam} live={live} prefs={prefs} onPrefsChange={alertPrefs.set} />
        </TabsContent>
        <TabsContent value="questions" className="teacher-panel mt-4">
          <QuestionsEditor exam={exam} questions={questions} onSaved={setQuestions} />
        </TabsContent>
        <TabsContent value="settings" className="teacher-panel mt-4">
          <SettingsForm exam={exam} onSaved={setExam} />
        </TabsContent>
        <TabsContent value="results" forceMount={resultsVisited ? true : undefined} className="teacher-panel mt-4 data-[state=inactive]:hidden">
          <ResultsPanel
            exam={exam}
            questions={questions}
            sessions={live.sessions}
            loading={live.loading}
            onExamChange={setExam}
            onSessionsChange={live.refresh}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}
