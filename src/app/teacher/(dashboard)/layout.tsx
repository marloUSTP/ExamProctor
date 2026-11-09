import Link from "next/link"
import { redirect } from "next/navigation"
import { ShieldCheckIcon } from "lucide-react"
import { UserMenu } from "@/components/teacher/user-menu"
import { createClient } from "@/lib/supabase/server"

export default async function TeacherLayout({ children }: LayoutProps<"/teacher">) {
  const supabase = await createClient()
  const { data } = await supabase.auth.getClaims()
  const claims = data?.claims
  if (!claims) redirect("/teacher/login")

  const email = String(claims.email ?? "")
  const name = String((claims.user_metadata as { full_name?: string } | undefined)?.full_name ?? email)

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="sticky top-0 z-30 border-b bg-background/90 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-7xl items-center justify-between px-4">
          <Link href="/teacher" className="flex items-center gap-2 font-semibold">
            <ShieldCheckIcon className="size-5" />
            Exam Proctor
          </Link>
          <UserMenu name={name} email={email} />
        </div>
      </header>
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8">{children}</main>
    </div>
  )
}
