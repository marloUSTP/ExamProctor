import type { Metadata } from "next"
import { TeacherLoginForm } from "@/components/teacher/teacher-login-form"

export const metadata: Metadata = { title: "Teacher sign in · Exam Proctor", robots: { index: false } }

export default async function TeacherLoginPage({ searchParams }: PageProps<"/teacher/login">) {
  const { next } = await searchParams
  // Only allow returning to pages inside the teacher area.
  const target = typeof next === "string" && next.startsWith("/teacher") ? next : "/teacher"

  return (
    <main className="flex flex-1 items-center justify-center px-4 py-16">
      <TeacherLoginForm next={target} />
    </main>
  )
}
