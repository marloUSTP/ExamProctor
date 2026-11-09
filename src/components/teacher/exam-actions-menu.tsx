"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"
import { ArchiveIcon, CopyIcon, FileDownIcon, Loader2Icon, MoreHorizontalIcon, RotateCcwIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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
import { createClient } from "@/lib/supabase/client"
import { errorMessage } from "@/lib/format"
import { buildExamDocx, TEMPLATE_URL } from "@/lib/exam-docx"
import type { Question } from "@/lib/types"

/** The ⋯ menu for an exam (exam list cards and the exam page header). */
export function ExamActionsMenu({
  examId,
  title,
  archived = false,
  onArchiveChange,
}: {
  examId: string
  title: string
  archived?: boolean
  onArchiveChange?: (archived: boolean) => void
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function duplicate() {
    setBusy(true)
    const { data, error } = await createClient().rpc("teacher_duplicate_exam", { p_exam_id: examId })
    if (error) {
      setBusy(false)
      return toast.error(errorMessage(error))
    }
    toast.success(`Duplicated “${title}”`, {
      description: "The copy is a draft with a new exam code. Edit it, then click “Open exam”.",
    })
    router.push(`/teacher/exams/${data}?tab=questions`)
    router.refresh()
  }

  async function exportDocx() {
    setBusy(true)
    try {
      const [{ data, error }, template] = await Promise.all([
        createClient().from("questions").select("*").eq("exam_id", examId).order("position"),
        fetch(TEMPLATE_URL).then((r) => {
          if (!r.ok) throw new Error("Couldn't load the Word template.")
          return r.arrayBuffer()
        }),
      ])
      if (error) throw error
      if (!data?.length) return toast.error("This exam has no questions yet.")
      const blob = await buildExamDocx(template, title, data as Question[])
      const url = URL.createObjectURL(blob)
      Object.assign(document.createElement("a"), {
        href: url,
        download: `${title.replace(/[^\w\- ]+/g, "").trim() || "exam"}.docx`,
      }).click()
      URL.revokeObjectURL(url)
      toast.success("Test paper downloaded", { description: "Choices are shuffled; the answer key is on the last page." })
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  async function setArchived(nextArchived: boolean) {
    setBusy(true)
    const { error } = await createClient().rpc(nextArchived ? "teacher_archive_exam" : "teacher_restore_exam", {
      p_exam_id: examId,
    })
    setBusy(false)
    if (error) return toast.error(errorMessage(error))
    toast.success(nextArchived ? `Archived “${title}”` : `Restored “${title}”`, {
      description: nextArchived ? "It is now in Archived exams and can be restored." : "It is back in Your exams as a closed exam.",
    })
    onArchiveChange?.(nextArchived)
    router.refresh()
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" aria-label={`More actions for ${title}`} disabled={busy}>
          {busy ? <Loader2Icon className="animate-spin" /> : <MoreHorizontalIcon />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {archived ? (
          <DropdownMenuItem onSelect={() => setArchived(false)}>
            <RotateCcwIcon />
            Restore exam
          </DropdownMenuItem>
        ) : (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <DropdownMenuItem onSelect={(event) => event.preventDefault()}>
                <ArchiveIcon />
                Archive exam
              </DropdownMenuItem>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Archive “{title}”?</AlertDialogTitle>
                <AlertDialogDescription>
                  The exam will be closed and removed from Your exams. Students can no longer join, and you can restore it later from Archived exams. Existing results are kept.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => setArchived(true)}>Archive exam</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
        <DropdownMenuItem onSelect={duplicate}>
          <CopyIcon />
          Duplicate exam
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={exportDocx}>
          <FileDownIcon />
          Export to Word
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
