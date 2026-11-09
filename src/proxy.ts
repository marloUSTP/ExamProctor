import type { NextRequest } from "next/server"
import { updateSession } from "@/lib/supabase/middleware"

export async function proxy(request: NextRequest) {
  return updateSession(request)
}

export const config = {
  // Only the teacher area (including /teacher/login) needs the Supabase session.
  matcher: ["/teacher", "/teacher/:path*"],
}
