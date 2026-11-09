"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"
import { Loader2Icon, ShieldCheckIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { createClient } from "@/lib/supabase/client"

// Supabase Auth signs in by email; teacher accounts use a username stored under this domain
// (see supabase/seed-teacher.sql). Typing a full email also works.
const USERNAME_DOMAIN = "exam-proctor.local"

function toEmail(username: string) {
  const value = username.trim().toLowerCase()
  return value.includes("@") ? value : `${value}@${USERNAME_DOMAIN}`
}

export function TeacherLoginForm({ next }: { next: string }) {
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    setPending(true)
    setError(null)
    const { error } = await createClient().auth.signInWithPassword({
      email: toEmail(String(form.get("username"))),
      password: String(form.get("password")),
    })
    if (error) {
      setError(error.message === "Invalid login credentials" ? "Wrong username or password." : error.message)
      setPending(false)
      return
    }
    router.replace(next)
    router.refresh()
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <ShieldCheckIcon className="mb-2 size-6 text-muted-foreground" />
        <CardTitle>Teacher sign in</CardTitle>
        <CardDescription>Manage exams and monitor students live.</CardDescription>
      </CardHeader>
      <form onSubmit={onSubmit}>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="username">Username</Label>
            <Input id="username" name="username" required autoComplete="username" autoCapitalize="none" spellCheck={false} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input id="password" name="password" type="password" required autoComplete="current-password" />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </CardContent>
        <CardFooter className="mt-6">
          <Button type="submit" className="w-full" disabled={pending}>
            {pending && <Loader2Icon className="animate-spin" />}
            Sign in
          </Button>
        </CardFooter>
      </form>
    </Card>
  )
}
