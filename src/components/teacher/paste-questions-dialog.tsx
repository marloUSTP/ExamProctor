"use client"

import { useMemo, useRef, useState } from "react"
import { ClipboardPasteIcon, Loader2Icon, TriangleAlertIcon, UploadIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { QUESTION_TYPE_LABEL } from "@/lib/format"
import { parseQuestions, type ParsedQuestion, type PasteMode } from "@/lib/parse-questions"
import type { QuestionType } from "@/lib/types"

const MODES: Record<PasteMode, { label: string; hint: string; example: string }> = {
  auto: {
    label: "Auto-detect (mixed)",
    hint: "Each question's type is detected: headings like “Test II. True or False” set the type for the questions under them; otherwise lettered choices → Multiple choice, answers like (True)/(F) → True/False, other answers → Identification. Check the preview on the right.",
    example: `1. Which best reflects the ACM definition of HCI?
a. A branch of CS focused only on UI code
b. A discipline concerned with interactive computing systems for human use
c. A marketing strategy
Answer: b

2. The sky is blue.
a. True
b. False
Answer: a

3. Who is the national hero of the Philippines?
Answer: Jose Rizal / Rizal`,
  },
  multiple_choice: {
    label: "Multiple choice",
    hint: "Every question becomes Multiple choice. Put each choice on its own line (a. b. c. d.). Add “Answer: b” or a * on the correct choice, or mark it after importing.",
    example: `1. Which best reflects the ACM definition of HCI?
a. A branch of CS focused only on UI code
b. A discipline concerned with interactive computing systems for human use
c. A marketing strategy
d. A hardware specialty
Answer: b

2. Why does designing for usability matter?
a. It has no measurable effect
b. It only affects looks
c. It reduces errors and improves satisfaction *
d. It's a legal requirement`,
  },
  true_false: {
    label: "True / False",
    hint: "Every question becomes True/False. Put the answer at the end like “(True)” / “(F)”, on a line “Answer: True”, or in an answer key — or set it after importing.",
    example: `1. The sky is blue. (True)
2. HCI only studies hardware. (False)
3. Usability affects productivity.
Answer: True

Answer key:
4. F`,
  },
  identification: {
    label: "Identification",
    hint: "Every question becomes Identification. Add “Answer: …” under each; separate other accepted answers with /.",
    example: `1. Who is the national hero of the Philippines?
Answer: Jose Rizal / Rizal

2. What does HCI stand for?
Answer: Human-Computer Interaction / Human Computer Interaction`,
  },
  essay: {
    label: "Essay / Scenario",
    hint: "Every question becomes an Essay. Students submit written responses to be reviewed and graded by the teacher.",
    example: `1. Explain two ways this change reflects the evolution of user interaction. [10 points]
2. Recommend one hardware action and one software action for memory bottleneck. [10 points]`,
  },
}

const LETTERS = "ABCDEFGHIJ"

export function hasAnswer(q: ParsedQuestion) {
  if (q.type === "essay") return true
  return q.type === "identification" ? q.accepted.length > 0 : q.correct !== ""
}

export function PasteQuestionsDialog({ onImport }: { onImport: (questions: ParsedQuestion[]) => void }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState("")
  const [mode, setMode] = useState<PasteMode>("auto")
  const [fileName, setFileName] = useState("")
  const [readingFile, setReadingFile] = useState(false)
  const [fileError, setFileError] = useState("")
  const [typeOverrides, setTypeOverrides] = useState<Record<number, QuestionType>>({})
  const fileInput = useRef<HTMLInputElement>(null)
  const detected = useMemo(() => parseQuestions(text, mode), [text, mode])
  const parsed = useMemo(
    () => detected.map((question, index) => convertQuestionType(question, typeOverrides[index] ?? question.type)),
    [detected, typeOverrides],
  )
  const missing = parsed.filter((q) => !hasAnswer(q)).length

  async function readFile(file: File) {
    setReadingFile(true)
    setFileError("")
    setFileName("")

    try {
      if (file.size > 20 * 1024 * 1024) {
        throw new Error("Choose a file smaller than 20 MB.")
      }

      const extension = file.name.toLowerCase().split(".").pop()
      let extracted = ""

      if (extension === "docx") {
        const mammoth = await import("mammoth")
        const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })
        extracted = result.value
      } else if (extension === "pdf") {
        const pdfjs = await import("pdfjs-dist")
        pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs"
        const loadingTask = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) })
        const document = await loadingTask.promise
        const pages: string[] = []

        try {
          for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
            const page = await document.getPage(pageNumber)
            const content = await page.getTextContent()
            const lines: string[] = []
            let line = ""
            let lineY: number | null = null

            const finishLine = () => {
              if (line.trim()) lines.push(line.trim())
              line = ""
              lineY = null
            }

            for (const item of content.items) {
              if (!("str" in item) || !item.str.trim()) continue
              const y = item.transform?.[5]
              if (line && y !== undefined && lineY !== null && Math.abs(y - lineY) > 2.5) finishLine()
              line = line ? `${line} ${item.str}` : item.str
              if (y !== undefined) lineY = y
              if (item.hasEOL) finishLine()
            }

            finishLine()
            pages.push(lines.join("\n"))
            page.cleanup()
          }
        } finally {
          await loadingTask.destroy()
        }

        extracted = pages.join("\n\n")
      } else {
        throw new Error("Choose a .docx Word document or a PDF file.")
      }

      if (!extracted.trim()) {
        throw new Error("No selectable text was found. Scanned or image-only PDFs aren’t supported.")
      }

      setText(extracted.trim())
      setTypeOverrides({})
      setFileName(file.name)
    } catch (error) {
      setFileError(error instanceof Error ? error.message : "Could not read that file.")
    } finally {
      setReadingFile(false)
      if (fileInput.current) fileInput.current.value = ""
    }
  }

  function importAll() {
    onImport(parsed)
    setText("")
    setTypeOverrides({})
    setFileName("")
    setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <ClipboardPasteIcon />
          Import questions
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Import questions</DialogTitle>
          <DialogDescription>
            Upload a .docx or text-based PDF, or paste questions below. The file is read in your browser and isn’t uploaded.
            Numbered questions (1. 2. 3.) are filled in automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
          <div className="flex items-center gap-2">
            <input
              ref={fileInput}
              type="file"
              accept=".docx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              className="hidden"
              aria-label="Choose a Word or PDF questionnaire"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0]
                if (file) void readFile(file)
              }}
            />
            <Button type="button" variant="outline" disabled={readingFile} onClick={() => fileInput.current?.click()}>
              {readingFile ? <Loader2Icon className="animate-spin" /> : <UploadIcon />}
              {readingFile ? "Reading file…" : "Upload Word/PDF"}
            </Button>
            {fileName && <span className="max-w-52 truncate text-sm text-muted-foreground">{fileName}</span>}
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="paste-type" className="shrink-0">
              Question type
            </Label>
            <Select value={mode} onValueChange={(v) => {
              setMode(v as PasteMode)
              setTypeOverrides({})
            }}>
              <SelectTrigger id="paste-type" className="w-52">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(MODES) as PasteMode[]).map((m) => (
                  <SelectItem key={m} value={m}>
                    {MODES[m].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <p className="min-w-60 flex-1 text-sm text-muted-foreground">{MODES[mode].hint}</p>
        </div>

        {fileError && <p role="alert" className="text-sm text-destructive">{fileError}</p>}

        <div className="grid gap-4 md:grid-cols-2">
          <Textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              setTypeOverrides({})
            }}
            placeholder={MODES[mode].example}
            aria-label="Question text"
            className="h-[50vh] resize-none font-mono text-xs"
            autoFocus
          />
          <ScrollArea className="h-[50vh] rounded-lg border">
            <div className="space-y-3 p-3">
              {parsed.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  A preview of the questions appears here as you paste.
                </p>
              ) : (
                parsed.map((q, i) => (
                  <div key={i} className="rounded-lg border p-3 text-sm">
                    <div className="mb-1 flex flex-wrap items-center gap-2">
                      <span className="font-medium">Question {i + 1}</span>
                      <Select
                        value={q.type}
                        onValueChange={(value) =>
                          setTypeOverrides((current) => ({ ...current, [i]: value as QuestionType }))
                        }
                      >
                        <SelectTrigger
                          aria-label={`Type for question ${i + 1}`}
                          className="h-7 w-auto min-w-36 gap-1 rounded-full border-0 bg-secondary px-2.5 text-xs font-medium shadow-none"
                        >
                          <SelectValue>{QUESTION_TYPE_LABEL[q.type]}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {(Object.keys(MODES).filter((type) => type !== "auto") as QuestionType[]).map((type) => (
                            <SelectItem key={type} value={type}>{QUESTION_TYPE_LABEL[type]}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Badge variant="outline" className="text-xs">
                        {q.points} pt{q.points === 1 ? "" : "s"}
                      </Badge>
                      {!hasAnswer(q) && (
                        <Badge variant="outline" className="border-amber-500/50 text-amber-700 dark:text-amber-400">
                          No answer yet
                        </Badge>
                      )}
                    </div>
                    <p className="text-muted-foreground">{q.prompt}</p>
                    {q.type === "multiple_choice" && (
                      <ul className="mt-2 space-y-0.5">
                        {q.choices.map((c, ci) => (
                          <li key={ci} className={q.correct === String(ci) ? "font-medium text-emerald-700 dark:text-emerald-400" : ""}>
                            {LETTERS[ci]}. {c}
                            {q.correct === String(ci) && " ✓"}
                          </li>
                        ))}
                      </ul>
                    )}
                    {q.type === "true_false" && q.correct && (
                      <p className="mt-2 font-medium text-emerald-700 dark:text-emerald-400">
                        Answer: {q.correct === "true" ? "True" : "False"} ✓
                      </p>
                    )}
                    {q.type === "identification" && q.accepted.length > 0 && (
                      <p className="mt-2 font-medium text-emerald-700 dark:text-emerald-400">
                        Answer: {q.accepted.join(" / ")} ✓
                      </p>
                    )}
                    {q.type === "essay" && (
                      <p className="mt-2 text-xs italic text-muted-foreground">
                        Student responds with written text · Graded manually by teacher
                      </p>
                    )}
                  </div>
                ))
              )}
            </div>
          </ScrollArea>
        </div>

        <DialogFooter className="items-center gap-3 sm:justify-between">
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            {parsed.length > 0 && missing > 0 && <TriangleAlertIcon className="size-4 text-amber-600" />}
            {parsed.length === 0
              ? "Nothing to import yet."
              : missing > 0
                ? `${parsed.length} found · ${missing} still need the correct answer — you can mark them after importing.`
                : `${parsed.length} found, all with answers.`}
          </p>
          <Button onClick={importAll} disabled={parsed.length === 0}>
            Add {parsed.length || ""} question{parsed.length === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function convertQuestionType(question: ParsedQuestion, type: QuestionType): ParsedQuestion {
  if (question.type === type) return question
  if (type === "essay") {
    return { ...question, type, choices: [], correct: "", accepted: [] }
  }
  if (type === "identification") {
    const selectedChoice = question.type === "multiple_choice"
      ? question.choices[Number(question.correct)]
      : question.type === "true_false" ? question.correct : ""
    return {
      ...question,
      type,
      choices: [],
      correct: "",
      accepted: question.accepted.length ? question.accepted : selectedChoice ? [selectedChoice] : [],
    }
  }
  if (type === "true_false") {
    const answer = question.type === "identification"
      ? question.accepted[0]?.toLowerCase()
      : question.type === "multiple_choice"
        ? question.choices[Number(question.correct)]?.toLowerCase()
        : question.correct
    const correct = ["true", "t", "tama"].includes(answer ?? "")
      ? "true"
      : ["false", "f", "mali"].includes(answer ?? "") ? "false" : ""
    return { ...question, type, choices: [], correct, accepted: [] }
  }
  const choices = question.type === "multiple_choice" ? question.choices : ["", "", "", ""]
  const existingAnswer = question.type === "identification" ? question.accepted[0] : ""
  const correct = existingAnswer ? String(choices.findIndex((choice) => choice.toLowerCase() === existingAnswer.toLowerCase())) : ""
  return { ...question, type, choices, correct: correct === "-1" ? "" : correct, accepted: [] }
}
