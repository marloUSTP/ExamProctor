import { Badge } from "@/components/ui/badge"
import type { ExamStatus } from "@/lib/types"

const META: Record<ExamStatus, { label: string; variant: "secondary" | "default" | "outline" }> = {
  draft: { label: "Draft", variant: "outline" },
  open: { label: "Open", variant: "default" },
  closed: { label: "Closed", variant: "secondary" },
}

export function ExamStatusBadge({ status, scheduled }: { status: ExamStatus; scheduled?: boolean }) {
  const meta = scheduled && status !== "closed" ? { label: "Scheduled", variant: "secondary" as const } : META[status]
  return <Badge variant={meta.variant}>{meta.label}</Badge>
}
