import {
  BanIcon,
  CheckIcon,
  LogInIcon,
  LogOutIcon,
  MinusCircleIcon,
  Minimize2Icon,
  MoonIcon,
  OctagonAlertIcon,
  PlayIcon,
  RotateCcwIcon,
  SendIcon,
  SunIcon,
  Undo2Icon,
  UserPlusIcon,
  XIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import type { EventType } from "@/lib/types"

const ICONS: Record<EventType, { icon: typeof CheckIcon; className: string }> = {
  join_requested: { icon: UserPlusIcon, className: "text-sky-600 bg-sky-500/10" },
  approved: { icon: CheckIcon, className: "text-emerald-600 bg-emerald-500/10" },
  rejected: { icon: XIcon, className: "text-muted-foreground bg-muted" },
  started: { icon: PlayIcon, className: "text-emerald-600 bg-emerald-500/10" },
  left: { icon: LogOutIcon, className: "text-red-600 bg-red-500/10" },
  returned: { icon: LogInIcon, className: "text-muted-foreground bg-muted" },
  idle: { icon: MoonIcon, className: "text-amber-600 bg-amber-500/10" },
  idle_ended: { icon: SunIcon, className: "text-muted-foreground bg-muted" },
  blocked_action: { icon: BanIcon, className: "text-muted-foreground bg-muted" },
  screenshot_attempt: { icon: BanIcon, className: "text-red-600 bg-red-500/10" },
  fullscreen_exit: { icon: Minimize2Icon, className: "text-muted-foreground bg-muted" },
  submitted: { icon: SendIcon, className: "text-emerald-600 bg-emerald-500/10" },
  auto_submitted: { icon: OctagonAlertIcon, className: "text-red-600 bg-red-500/10" },
  retake_allowed: { icon: RotateCcwIcon, className: "text-sky-600 bg-sky-500/10" },
  points_deducted: { icon: MinusCircleIcon, className: "text-red-600 bg-red-500/10" },
  deduction_undone: { icon: Undo2Icon, className: "text-emerald-600 bg-emerald-500/10" },
}

export function EventIcon({ type }: { type: EventType }) {
  const { icon: Icon, className } = ICONS[type]
  return (
    <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-full", className)}>
      <Icon className="size-3.5" />
    </span>
  )
}
