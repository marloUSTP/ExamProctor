"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"
import { Loader2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useBrowserValue } from "@/lib/browser-store"
import { errorMessage } from "@/lib/format"
import { studentApi, studentToken } from "@/lib/student-api"
import { studentNameParts } from "@/lib/student-name"

const cleanCode = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6)

export function JoinForm({ initialCode }: { initialCode: string }) {
  const router = useRouter()
  const [enteredCode, setCode] = useState<string | null>(null)
  const savedCode = useBrowserValue(() => studentToken.lastCode(), null)
  const code = enteredCode ?? (cleanCode(initialCode) || savedCode || "")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [email, setEmail] = useState("")
  const [registrationFor, setRegistrationFor] = useState<{ code: string; email: string } | null>(null)
  const registering = registrationFor?.code === code && registrationFor.email === email.trim().toLowerCase()

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (pending) return
    const form = new FormData(e.currentTarget)
    setPending(true)
    setError(null)
    try {
      if (!registering) {
        const result = await studentApi.findOrContinue(code, email)
        if (!("token" in result)) {
          setRegistrationFor({ code, email: email.trim().toLowerCase() })
          setPending(false)
          return
        }
        studentToken.set(result.code, result.token)
        router.push(`/exam/${result.code}`)
        return
      }
      const { firstName, lastName } = studentNameParts(String(form.get("firstName") ?? ""), String(form.get("lastName") ?? ""))
      const { token, code: examCode } = await studentApi.join(
        code,
        email,
        firstName,
        lastName,
      )
      studentToken.set(examCode, token)
      router.push(`/exam/${examCode}`)
    } catch (err) {
      setError(errorMessage(err))
      setPending(false)
    }
  }

  return (
    <main className="flex flex-1 items-center justify-center px-4 py-8 sm:py-16">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{registering ? "Register for this exam" : "Join or continue an exam"}</CardTitle>
          <CardDescription aria-live="polite">{registering
            ? "No entry was found for this email. Enter your first and last name to request teacher approval."
            : "Enter your exam code and email. If you have already registered, you can continue immediately."}</CardDescription>
        </CardHeader>
        <form onSubmit={onSubmit} aria-busy={pending}>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="code">Exam code</Label>
              <Input
                id="code"
                value={code}
                onChange={(e) => { setCode(cleanCode(e.target.value)); setRegistrationFor(null); setError(null) }}
                placeholder="ABC123"
                className="font-mono text-lg tracking-widest uppercase"
                autoComplete="off"
                required
                disabled={pending}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" name="email" type="email" autoComplete="email" inputMode="email" autoCapitalize="none"
                value={email} onChange={(e) => { setEmail(e.target.value); setRegistrationFor(null); setError(null) }} required disabled={pending} />
            </div>
            {registering && <div className="registration-reveal space-y-4 border-t pt-4">
              <div className="space-y-2">
                <Label htmlFor="firstName">First name</Label>
                <Input id="firstName" name="firstName" autoComplete="given-name" autoCapitalize="characters" className="uppercase" placeholder="JUAN" required maxLength={60} disabled={pending} autoFocus />
              </div>
              <div className="space-y-2">
                <Label htmlFor="lastName">Last name</Label>
                <Input id="lastName" name="lastName" autoComplete="family-name" autoCapitalize="characters" className="uppercase" placeholder="DELA CRUZ" required maxLength={60} disabled={pending} />
              </div>
              <p className="text-xs text-muted-foreground">Names are saved in uppercase and checked for an existing entry before registration. Extra spaces do not matter.</p>
            </div>}
            {error && <p role="alert" className="registration-reveal rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</p>}
          </CardContent>
          <CardFooter className="mt-6">
            <Button type="submit" className="registration-submit min-h-11 w-full" disabled={pending || code.length !== 6}>
              {pending && <Loader2Icon className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}
              {pending ? registering ? "Registering…" : "Checking your entry…" : registering ? "Register and request approval" : "Join or continue"}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </main>
  )
}
