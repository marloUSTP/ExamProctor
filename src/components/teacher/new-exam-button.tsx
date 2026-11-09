"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"
import { Loader2Icon, PlusIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { createClient } from "@/lib/supabase/client"
import { errorMessage } from "@/lib/format"
import { toIsoDateTime } from "@/lib/schedule"

export function NewExamButton() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    const title = String(form.get("title")).trim()
    if (!title) return
    const start = String(form.get("scheduled_start_at") ?? "")
    const end = String(form.get("scheduled_end_at") ?? "")
    if (!!start !== !!end) return toast.error("Enter both a scheduled start and end time, or leave both blank.")
    if (start && (!toIsoDateTime(start) || !toIsoDateTime(end) || new Date(end) <= new Date(start)))
      return toast.error("The scheduled end must be after the start.")
    setPending(true)
    const { data, error } = await createClient().from("exams").insert({
      title,
      scheduled_start_at: toIsoDateTime(start),
      scheduled_end_at: toIsoDateTime(end),
    }).select("id").single()
    setPending(false)
    if (error) {
      toast.error(errorMessage(error))
      return
    }
    router.push(`/teacher/exams/${data.id}?tab=questions`)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <PlusIcon />
          New exam
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={onSubmit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>New exam</DialogTitle>
            <DialogDescription>You&apos;ll add questions and the answer key next.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="exam-title">Title</Label>
            <Input id="exam-title" name="title" placeholder="e.g. Science 7 — Quarter 1 Exam" required autoFocus />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="exam-start">Scheduled start (optional)</Label>
              <Input id="exam-start" name="scheduled_start_at" type="datetime-local" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="exam-end">Shared deadline</Label>
              <Input id="exam-end" name="scheduled_end_at" type="datetime-local" />
            </div>
          </div>
          <p className="text-sm text-muted-foreground">Set both times to schedule the exam. Every student shares the same end time, so late arrivals have less time.</p>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2Icon className="animate-spin" />}
              Create exam
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
