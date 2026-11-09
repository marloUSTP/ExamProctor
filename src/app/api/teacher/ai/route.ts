import { createClient } from "@/lib/supabase/server"
import { teacherAiHandler } from "@/lib/teacher-ai-handler"

export const runtime = "nodejs"
export const maxDuration = 60
export const POST = teacherAiHandler({ createClient })
