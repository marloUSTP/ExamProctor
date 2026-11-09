import Link from "next/link"
import { GraduationCapIcon, ShieldCheckIcon, TrophyIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-8 px-4 py-16">
      <div className="space-y-3 text-center">
        <div className="mx-auto flex size-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
          <ShieldCheckIcon className="size-6" />
        </div>
        <h1 className="text-3xl font-semibold tracking-tight">Exam Proctor</h1>
        <p className="text-muted-foreground">Take your exam online. Your teacher will give you the exam code.</p>
      </div>

      <Card>
        <CardHeader>
          <GraduationCapIcon className="mb-2 size-5 text-muted-foreground" />
          <CardTitle>Join an exam</CardTitle>
          <CardDescription>
            Enter the exam code, your email and your name. Your teacher approves you before the exam starts.
          </CardDescription>
        </CardHeader>
        <CardFooter>
          <Button asChild size="lg" className="w-full">
            <Link href="/join">Join an exam</Link>
          </Button>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader>
          <TrophyIcon className="mb-2 size-5 text-muted-foreground" />
          <CardTitle>Check my score</CardTitle>
          <CardDescription>Already took an exam? See your score with the result code you got after submitting.</CardDescription>
        </CardHeader>
        <CardFooter>
          <Button asChild size="lg" variant="outline" className="w-full">
            <Link href="/results">Check my score</Link>
          </Button>
        </CardFooter>
      </Card>
    </main>
  )
}
