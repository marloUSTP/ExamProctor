"use client"

import { CheckCircle2Icon, ClockIcon, CopyIcon, OctagonAlertIcon } from "lucide-react"
import { toast } from "sonner"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import { formatAnswer, formatKey, percent } from "@/lib/answers"
import { cn } from "@/lib/utils"
import type { StudentState } from "@/lib/types"

/** `live`: shown right after the exam (page keeps polling) vs. looked up later on "Check my score". */
export function ResultScreen({ state, live = true }: { state: StudentState; live?: boolean }) {
  const { session, exam, result } = state
  const review = state.review ?? []
  const auto = session.status === "auto_submitted"
  const partial = !!result && (result.is_partial ?? !!session.grading_pending)
  const pct = result && !partial ? percent(result.score, result.max_score) : null

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(session.result_code ?? "")
      toast.success("Result code copied")
    } catch {
      toast.error("Couldn't copy — write the code down instead.")
    }
  }

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 space-y-4 px-4 py-12">
      <Card>
        <CardHeader className="text-center">
          {auto ? (
            <OctagonAlertIcon className="mx-auto mb-2 size-8 text-destructive" />
          ) : (
            <CheckCircle2Icon className="mx-auto mb-2 size-8 text-emerald-600" />
          )}
          <CardTitle className="text-xl">{auto ? "Your exam was auto-submitted" : "Exam submitted"}</CardTitle>
          <CardDescription>
            {auto
              ? session.auto_submit_reason === "time_limit"
                ? "The shared deadline passed, so your saved answers were submitted automatically."
                : `You reached ${exam.max_violations} violations, so your answers were saved and submitted automatically.`
              : `Thank you, ${session.student_name}. Your answers for “${exam.title}” were recorded.`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {result ? (
            <div className="space-y-3 text-center">
              <p className="text-sm font-medium">{partial ? "Partial score" : "Final score"}</p>
              <div className="text-5xl font-semibold tabular-nums tracking-tight">
                {Number(result.score)} <span className="text-2xl text-muted-foreground">/ {Number(result.max_score)}</span>
              </div>
              {partial && (
                <p className="text-sm text-muted-foreground">
                  Points earned so far out of the full exam total. {result.pending_questions ?? "Some"} essay
                  {result.pending_questions === 1 ? " is" : "s are"} awaiting teacher grading. This is not your final score.
                </p>
              )}
              {pct !== null && (
                <>
                  <Progress value={pct} className="mx-auto h-2 max-w-xs" />
                  <div className="text-sm text-muted-foreground">{pct}%</div>
                </>
              )}
            </div>
          ) : (
            <p className="flex items-center justify-center gap-2 rounded-lg bg-muted px-4 py-3 text-sm text-muted-foreground">
              <ClockIcon className="size-4" />
              {session.grading_pending
                ? "Your answers were submitted. Essay grading is pending; available points will appear when results are released."
                : live
                ? "You can review your responses now. Correct answers and points appear when the exam ends or your teacher releases results."
                : "Your responses are available below. Correct answers and points appear when the exam ends or your teacher releases results."}
            </p>
          )}
        </CardContent>
        {session.result_code && (
          <CardFooter className="flex-col gap-2 border-t pt-4 text-center">
            <div className="text-sm text-muted-foreground">Your result code</div>
            <button
              type="button"
              onClick={copyCode}
              className="inline-flex items-center gap-2 rounded-lg border bg-muted px-4 py-2 font-mono text-2xl font-semibold tracking-widest hover:bg-muted/70"
            >
              {session.result_code}
              <CopyIcon className="size-4 text-muted-foreground" />
            </button>
            <p className="max-w-sm text-xs text-muted-foreground">
              Save this result code to check your score and responses later with exam code{" "}
              <span className="font-medium text-foreground"> {exam.code}</span> and the email you used for the exam.
            </p>
            <div className="mt-2 flex flex-wrap justify-center gap-2">
              {session.result_code && (
                <Dialog>
                  <DialogTrigger asChild>
                    <Button variant="outline">View answers</Button>
                  </DialogTrigger>
                  <DialogContent className="sm:max-w-2xl">
                  <DialogHeader>
                    <DialogTitle>Review your exam</DialogTitle>
                    <DialogDescription>
                      {session.grading_pending
                        ? result
                          ? "Available points are shown below. Essays marked Awaiting grading have no approved score yet."
                          : "Your responses are shown below. Essay grading is pending; points appear when results are released."
                        : result
                        ? "Your response, the correct answer, and points earned for each question."
                        : "Your responses are shown now. Correct answers and points appear when the exam ends or your teacher releases results."}
                    </DialogDescription>
                  </DialogHeader>
                  <ScrollArea className="max-h-[65vh] pr-3">
                    {review.length > 0 ? (
                      <ol className="space-y-3">
                        {review.map((item, i) => (
                        <li
                          key={item.question_id}
                          className="rounded-lg border bg-muted/20 p-3 text-sm"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="font-medium whitespace-pre-wrap">{i + 1}. {item.prompt}</div>
                            {item.points !== undefined && (
                              <span className="shrink-0 text-sm text-muted-foreground">
                                {item.grading_pending ? "Awaiting grading" : `${Number(item.points_awarded ?? 0)} / ${Number(item.points)} pts`}
                              </span>
                            )}
                          </div>
                          {item.points !== undefined && !item.grading_pending && Number(item.points_awarded) > 0 && Number(item.points_awarded) < Number(item.points) && (
                            <p className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-400">Partial credit</p>
                          )}
                          {item.type === "multiple_choice" && (
                            <ul className="mt-3 space-y-1.5">
                              {(item.choice_order?.length ? item.choice_order : item.choices.map((_, index) => index)).map((choiceIndex, displayIndex) => {
                                const selected = item.your_answer !== null && item.your_answer !== "" && Number(item.your_answer) === choiceIndex
                                const correct = item.correct_answers?.includes(String(choiceIndex)) ?? false
                                const graded = result !== null
                                return (
                                  <li
                                    key={choiceIndex}
                                    className={cn(
                                      "flex items-start justify-between gap-3 rounded-md border px-3 py-2",
                                      graded && correct && "border-emerald-500/50 bg-emerald-500/5",
                                      graded && selected && !correct && "border-destructive/50 bg-destructive/5",
                                      !graded && selected && "border-primary/50 bg-primary/5",
                                    )}
                                  >
                                    <span>{String.fromCharCode(65 + displayIndex)}. {item.choices[choiceIndex] || <span className="text-muted-foreground">(empty choice)</span>}</span>
                                    <span className="shrink-0 text-xs font-medium">
                                      {selected && <span className={graded ? correct ? "text-emerald-700 dark:text-emerald-400" : "text-destructive" : "text-primary"}>Your answer</span>}
                                      {selected && correct && " · "}
                                      {graded && correct && <span className="text-emerald-700 dark:text-emerald-400">Correct answer</span>}
                                    </span>
                                  </li>
                                )
                              })}
                            </ul>
                          )}
                          {item.type !== "multiple_choice" && (
                            <dl className="mt-2 grid gap-1 sm:grid-cols-[120px_1fr]">
                              <dt className="text-muted-foreground">{item.type === "essay" ? "Your response" : "Your answer"}</dt>
                              <dd>{formatAnswer(item.type, item.choices, item.your_answer, false)}</dd>
                              {item.correct_answers && (
                                <>
                                  <dt className="text-muted-foreground">Correct answer</dt>
                                  <dd>{formatKey(item.type, item.choices, item.correct_answers, false)}</dd>
                                </>
                              )}
                            </dl>
                          )}
                          {item.rubric_scores && <div className="mt-3 space-y-2 border-t pt-3">
                            <p className="font-medium">Rubric breakdown</p>
                            {item.rubric_scores.map((criterion, index) => <div key={index}>
                              <p>{criterion.name}: <span className="font-medium tabular-nums">{criterion.points} / {criterion.max_points}</span></p>
                              <p className="whitespace-pre-wrap text-xs text-muted-foreground">{criterion.reason}</p>
                            </div>)}
                          </div>}
                          {item.rubric_feedback && <p className="mt-3 whitespace-pre-wrap text-muted-foreground">{item.rubric_feedback}</p>}
                        </li>
                        ))}
                      </ol>
                    ) : (
                      <p className="py-8 text-center text-sm text-muted-foreground">
                        Your answer review is not available yet. Refresh the page and try again.
                      </p>
                    )}
                  </ScrollArea>
                  </DialogContent>
                </Dialog>
              )}
            </div>
          </CardFooter>
        )}
      </Card>
    </main>
  )
}
