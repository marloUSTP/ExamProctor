"use client"

import { useEffect, useState } from "react"
import { ArrowLeftIcon, Loader2Icon, SearchIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ResultScreen } from "@/components/student/result-screen"
import { errorMessage } from "@/lib/format"
import { studentApi } from "@/lib/student-api"
import type { StudentState } from "@/lib/types"

export function CheckScore() {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<StudentState | null>(null)
  const [lookup, setLookup] = useState<{ code: string; email: string; resultCode: string } | null>(null)

  useEffect(() => {
    if (!lookup) return
    let active = true
    let timer: ReturnType<typeof setTimeout>
    async function refresh() {
      try {
        const next = await studentApi.lookupResult(lookup!.code, lookup!.email, lookup!.resultCode)
        if (active) setResult(next)
      } catch {
        // Retry temporary connection failures on the next poll.
      } finally {
        if (active) timer = setTimeout(refresh, 10000)
      }
    }
    timer = setTimeout(refresh, 10000)
    return () => { active = false; clearTimeout(timer) }
  }, [lookup])

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    setPending(true)
    setError(null)
    try {
      const query = { code: String(form.get("code")), email: String(form.get("email")), resultCode: String(form.get("resultCode")) }
      setResult(
        await studentApi.lookupResult(query.code, query.email, query.resultCode)
      )
      setLookup(query)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setPending(false)
    }
  }

  if (result) {
    return (
      <div className="flex flex-1 flex-col">
        <div className="mx-auto w-full max-w-2xl px-4 pt-6">
          <Button variant="ghost" size="sm" className="-ml-2" onClick={() => { setLookup(null); setResult(null) }}>
            <ArrowLeftIcon />
            Check another score
          </Button>
        </div>
        <ResultScreen state={result} live={false} />
      </div>
    )
  }

  return (
    <main className="flex flex-1 items-center justify-center px-4 py-16">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Check my score</CardTitle>
          <CardDescription>Use the result code you got after submitting your exam.</CardDescription>
        </CardHeader>
        <form onSubmit={onSubmit}>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="code">Exam code</Label>
              <Input
                id="code"
                name="code"
                required
                maxLength={6}
                placeholder="ABC123"
                autoComplete="off"
                className="font-mono tracking-widest uppercase"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">Email you used for the exam</Label>
              <Input id="email" name="email" type="email" required autoComplete="email" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="resultCode">Result code</Label>
              <Input
                id="resultCode"
                name="resultCode"
                required
                maxLength={10}
                placeholder="R-4F9K2P"
                autoComplete="off"
                className="font-mono tracking-widest uppercase"
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </CardContent>
          <CardFooter className="mt-6 flex-col gap-3">
            <Button type="submit" className="w-full" disabled={pending}>
              {pending ? <Loader2Icon className="animate-spin" /> : <SearchIcon />}
              Show my score
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              Lost your result code? Ask your teacher — they can see it in the results list.
            </p>
          </CardFooter>
        </form>
      </Card>
    </main>
  )
}

