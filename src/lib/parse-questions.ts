import type { QuestionType } from "@/lib/types"

/**
 * Generalized Multi-Pass Parser for Exam Documents (Word .docx, PDF, Pasted text).
 *
 * Supported Question Formats:
 *   1. Multiple Choice:
 *      - 1-per-line: "a. Alpha \n b. Beta \n c. Gamma \n d. Delta"
 *      - All-in-1-line: "A. Alpha    B. Beta    C. Gamma    D. Delta"
 *      - 2x2 grid: "A. Alpha   B. Beta \n C. Gamma   D. Delta"
 *      - Markers: "A.", "a)", "(A)", "[A]", "A:", "A -"
 *
 *   2. True or False:
 *      - Standalone binary choices ("a. True \n b. False")
 *      - Inline markers ("The sky is blue. (True)")
 *      - Section headers ("Test I. True or False")
 *
 *   3. Fill in the Blank / Identification / Short Answer:
 *      - Prompts containing blanks ("The capital is _______.")
 *      - Conversion / computation questions ("Convert 73 base 10 to binary.")
 *      - Direct questions ("What is the capital of Japan? Answer: Tokyo")
 *
 *   4. Essay / Scenario-Based:
 *      - Prompts starting with "Explain...", "Evaluate...", "Discuss...", "Analyze..."
 *      - High point values or section headers ("Part II - Essay / Scenario-Based")
 *
 * Supported Metadata & Points:
 *   - Per-question points: "[10 points]", "(5 pts)", "[6 marks]", "10 points:"
 *   - Section-level points: "Directions: Each item is worth 2 points.", "(5 points each)"
 *   - Flexible question starts: "1.", "1)", "(1)", "Q1:", "Item 1.", "Problem 1."
 *   - Answer keys: inline ("Answer: b", "*C") or at end ("Answer key: 1. A  2. B")
 */

export interface ParsedQuestion {
  type: QuestionType
  prompt: string
  choices: string[]
  /** multiple_choice: index as string; true_false: "true" | "false"; "" when unknown */
  correct: string
  /** identification: accepted answers */
  accepted: string[]
  points: number
}

/** "Auto" decides per question; any other value makes every pasted question that type. */
export type PasteMode = "auto" | QuestionType

interface Block {
  number: number
  prompt: string
  choices: string[]
  marked: number | null
  answer: string | null
  /** Type named by the section heading above this question, if any. */
  section: QuestionType | null
  /** Stable group index used for section-wide inference and restarted question numbers. */
  group: number
  points: number
}

// Matches question starts: "1.", "1)", "(1)", "1 -", "1:", "Q1.", "Q1:", "Question 1.", "Item 1.", "Problem 1."
const QUESTION_RE =
  /^(?:(?:question|item|problem|no|q)\s*[.:\-–—]?\s*)?\(?(\d{1,3})\s*[.):\-–—]\s*(.*)$/i

// Matches single choice at start of line: "A.", "a)", "(a)", "[A]", "A:", "A -"
const CHOICE_START_RE =
  /^(?:[\(\[]\s*([a-j])\s*[\)\]]|([a-j])\s*[.):\-–—])\s*(.*)$/i

// Matches any choice marker anywhere in a line (for inline / multiple-per-line choices): "(A)", "[A]", "A.", "A)"
const ANY_CHOICE_MARKER_RE =
  /(?:^|\s{2,}|\t|\s+)(?:[\(\[]\s*([a-j])\s*[\)\]]|([a-j])\s*[.):\-–—])\s*/gi

const ANSWER_RE = /^(?:correct\s+answer|answer|ans|key)\s*[:.\-=]\s*(.+)$/i
const KEY_HEADER_RE = /^(?:answer\s*key|answers|key\s*to\s*correction)(?:\s*[:\-–—]\s*(.*))?$/i
const KEY_PAIR_RE = /(?:^|\s)(\d{1,3})\s*[.)\-:=]\s*(.+?)(?=\s+\d{1,3}\s*[.)\-:=]|\s*$)/g
const MARK_RE = /^\s*[\*✓✔]\s*|\s*[\*✓✔]\s*$|\s*\((?:correct|answer)\)\s*$|^\s*\[[xX]\]\s*/gi

// Points tags: "[10 points]", "(10 pts)", "[5 marks]", "(15pts)", "[10 pt.]", "10 points:", "(5)"
const POINTS_TAG_RE =
  /(?:[\[(]\s*(\d{1,3})\s*(?:points?|pts?\.?|marks?)\s*[\])]|(?:\s*[-–—]\s*)?(\d{1,3})\s*(?:points?|pts?\.?)\b)/i

// Section points: "Each item is worth 5 points", "(5 points each)", "2 pts each", "10 points per question"
const SECTION_POINTS_RE =
  /(?:each\s+(?:item|question|problem)?\s*(?:is\s+worth)?\s*(\d{1,3})\s*(?:points?|pts?)|(\d{1,3})\s*(?:points?|pts?)\s*(?:each|per\s+(?:item|question)))/i

// Paper noise: lines of only underscores, dashes, equal signs
const PAPER_LINE_RE = /^[\s_\-–—=]{4,}$/
const PAGE_MARKER_RE = /^(?:page\s+)?\d{1,3}\s+of\s+\d{1,3}$/i

// Header metadata table: Name, Date, Score, etc.
const HEADER_METADATA_RE =
  /^(?:\|\s*)?(?:student(?:\s+name)?|name|date|score|instructor|subject|class|period)\s*[:|_]+/i
const SECTION_PREFIX_RE = /^(part|section|test|exam|unit|module)\s*([ivxlcdm]+|\d+|[a-z])\s*[.:)\-–—]?\s*(.*)$/i
const ROMAN_SECTION_RE = /^([ivxlcdm]+)\s*[.):\-–—]\s*(.+)$/i

// Directions under sections
const DIRECTIONS_RE =
  /^(?:general\s+)?(?:directions?|instructions?)\s*[:.\-–—]/i

// Broad section detection:
// Matches "Part I", "Test 2", "Section A", "I. Multiple Choice", "Test III - Identification"
const SECTION_RE =
  /^(?:(?:test|part|section|type|exam|unit|module)\s*([ivxlc\d]+|[a-z])\s*[.:)\-–—]?\s*|[ivxlc]+\s*[.):\-–—]\s*)?((?:modified\s+)?true\s*(?:or|\/|&|and|-)\s*false|t\s*\/\s*f|identification|short\s*answers?|fill[\s-]*(?:in[\s-]*)?(?:the[\s-]*)?blanks?|completion|multiple[\s-]*choices?|mcqs?|scenario[\s-]*based|essays?|situational|case[\s-]*stud(?:y|ies)|discussion|written[\s-]*work|number[\s-]*conversions?|problem[\s-]*solving|computations?)\b/i

const TRAILING_TF_RE = /\s*[(\[]\s*(true|false|t|f|tama|mali)\s*[)\]]\s*$/i
const TF_PREFIX_RE = /^(?:true\s*or\s*false|t\s*or\s*f|t\s*\/\s*f)\s*[:.\-–—]\s*/i
const TF_WORD_RE = /^(true|false|t|f|tama|mali)$/i

// Action words commonly indicating an essay or open-ended scenario question
const ESSAY_PROMPT_RE =
  /^(?:explain|describe|evaluate|recommend|analyze|discuss|in\s+your\s+own\s+words|compare\s+and\s+contrast|justify|reflect|synthesize|elaborate|why\s+does|how\s+does)\b/i

// Short answer prompt cues
const SHORT_ANSWER_PROMPT_RE =
  /^(?:what\s+is|who\s+is|who\s+was|where\s+is|when\s+did|which\s+(?:term|word|component)|define|identify|convert|calculate|solve|find\s+the|name\s+the)\b/i

const BLANK_IN_PROMPT_RE = /_{3,}|\[\s*_{2,}\s*\]|\.{4,}/

function clean(text: string) {
  return text
    .replace(/[ \t]+/g, " ")
    .replace(/[​﻿]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim()
}

function stripMark(text: string): { text: string; marked: boolean } {
  const stripped = text.replace(MARK_RE, "").trim()
  return { text: stripped, marked: stripped !== text.trim() }
}

const letterIndex = (letter: string) => letter.toLowerCase().charCodeAt(0) - 97

function toTrueFalse(value: string): "true" | "false" | "" {
  const v = value.trim().toLowerCase()
  if (["true", "t", "tama", "a"].includes(v)) return "true"
  if (["false", "f", "mali", "b"].includes(v)) return "false"
  return ""
}

function parseSection(line: string): { type: QuestionType; defaultPoints: number | null } | null {
  if (line.length > 200) return null
  const m = line.match(SECTION_RE)
  if (!m) return null

  const kind = m[2].toLowerCase()
  let type: QuestionType = "multiple_choice"
  if (kind.startsWith("ident") || kind.startsWith("short") || kind.includes("blank") || kind.startsWith("completion")) {
    type = "identification"
  } else if (kind.startsWith("true") || kind.startsWith("t/") || kind === "t / f") {
    type = "true_false"
  } else if (
    kind.startsWith("scenario") ||
    kind.startsWith("essay") ||
    kind.startsWith("situat") ||
    kind.startsWith("case") ||
    kind.startsWith("discussion") ||
    kind.startsWith("written")
  ) {
    type = "essay"
  } else if (kind.startsWith("number") || kind.startsWith("problem") || kind.startsWith("comput")) {
    type = "identification"
  } else if (kind.startsWith("multiple") || kind.startsWith("mcq")) {
    type = "multiple_choice"
  }

  let defaultPoints: number | null = null
  const ptsM = line.match(SECTION_POINTS_RE)
  if (ptsM) {
    defaultPoints = Number(ptsM[1] || ptsM[2])
  }

  return { type, defaultPoints }
}

/** Extracts choices if multiple appear on a line, e.g. "A. Cat  B. Dog" or "(A) Cat  (B) Dog" */
function extractChoicesFromLine(line: string, currentChoicesCount: number): string[] | null {
  const matches = [...line.matchAll(ANY_CHOICE_MARKER_RE)]
  if (matches.length === 0) return null

  // Verify that these markers continue the expected alphabetical sequence
  const letters = matches.map((m) => (m[1] || m[2]).toLowerCase().charCodeAt(0) - 97)
  let expected = currentChoicesCount
  for (let i = 0; i < letters.length; i++) {
    if (letters[i] !== expected) return null
    expected++
  }

  const choices: string[] = []
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index + matches[i][0].length
    const end = i + 1 < matches.length ? matches[i + 1].index : line.length
    choices.push(line.slice(start, end).trim())
  }
  return choices
}

function splitInlineQuestionChoices(prompt: string) {
  const choices = extractChoicesFromLine(prompt, 0)
  const markers = [...prompt.matchAll(ANY_CHOICE_MARKER_RE)]
  if (!choices || choices.length < 2 || markers.length < 2) return { prompt, choices: [] as string[] }
  const start = markers[0].index ?? 0
  return { prompt: prompt.slice(0, start).trim(), choices }
}

/** Which choice the answer points to: a star mark, a letter ("b", "(b)", "B."), or the choice's own text. */
function answerIndex(block: Block, choices: string[], answer: string): number | null {
  if (block.marked !== null) return block.marked
  if (!answer) return null
  const letter = answer.match(/^\(?([a-j])\)?(?:[.)]|\s|$)/i)
  if (letter && letterIndex(letter[1]) < choices.length) return letterIndex(letter[1])
  const byText = choices.findIndex((c) => c.toLowerCase() === answer.toLowerCase())
  return byText === -1 ? null : byText
}

const splitAccepted = (answer: string) =>
  answer
    .split(/\s*[\/;|]\s*/)
    .map((a) => a.trim())
    .filter(Boolean)

function finish(block: Block, type: QuestionType): ParsedQuestion {
  let prompt = block.prompt.trim()
  const choices = block.choices.map((c) => c.trim())
  let answer = block.answer?.trim() ?? ""
  const points = Math.max(1, block.points)

  if (type === "essay") {
    return { type, prompt, choices: [], correct: "", accepted: [], points }
  }

  if (type === "true_false") {
    const trailing = prompt.match(TRAILING_TF_RE)
    if (trailing) {
      prompt = prompt.replace(TRAILING_TF_RE, "").trim()
      answer ||= trailing[1]
    }
    prompt = prompt.replace(TF_PREFIX_RE, "").trim()
    const i = answerIndex(block, choices, answer)
    const fromChoice = i !== null && choices[i] ? toTrueFalse(choices[i]) : ""
    const isTfChoices =
      choices.length === 2 &&
      ((choices[0].toLowerCase() === "true" && choices[1].toLowerCase() === "false") ||
       (choices[0].toLowerCase() === "tama" && choices[1].toLowerCase() === "mali"))
    const correct = fromChoice || (isTfChoices || TF_WORD_RE.test(answer) ? toTrueFalse(answer) : "")
    return { type, prompt, choices: [], correct, accepted: [], points }
  }

  if (type === "multiple_choice") {
    const i = answerIndex(block, choices, answer)
    // Leave at least 4 slots if teacher wants to fill in
    const filled = choices.length >= 2 ? choices : [...choices, "", "", "", ""].slice(0, Math.max(4, choices.length))
    return { type, prompt, choices: filled, correct: i === null ? "" : String(i), accepted: [], points }
  }

  // Identification / Fill in the blank / Short answer
  const i = choices.length ? answerIndex(block, choices, answer) : null
  const accepted = i !== null ? [choices[i]] : splitAccepted(answer)
  return { type: "identification", prompt, choices: [], correct: "", accepted, points }
}

function parseQuestionsOneSection(raw: string, mode: PasteMode = "auto"): ParsedQuestion[] {
  const blocks: Block[] = []
  const key = new Map<number, string>()
  let current: Block | null = null
  let inKey = false
  let section: QuestionType | null = null
  let sectionDefaultPoints: number | null = null
  let group = 0

  for (const rawLine of raw.replace(/\r\n?/g, "\n").split("\n")) {
    const line = clean(rawLine)
    if (!line) continue

    // Discard standalone paper noise (underlines, divider lines)
    if (PAPER_LINE_RE.test(line)) continue

    // Discard header metadata table (Name, Date, Score) before questions begin
    if (HEADER_METADATA_RE.test(line) && !current) continue

    if (KEY_HEADER_RE.test(line)) {
      inKey = true
      continue
    }

    if (inKey) {
      const pairs = [...line.matchAll(KEY_PAIR_RE)]
      if (pairs.length > 1) pairs.forEach((m) => key.set(Number(m[1]), m[2]))
      else {
        const one = line.match(/^(\d{1,3})\s*[.)\-:=]\s*(.+)$/)
        if (one) key.set(Number(one[1]), one[2].trim())
      }
      continue
    }

    // Section heading check
    const sec = parseSection(line)
    if (sec) {
      section = sec.type
      sectionDefaultPoints = sec.defaultPoints
      group++
      current = null
      continue
    }

    // Directions line under section heading
    if (DIRECTIONS_RE.test(line)) {
      const ptsM = line.match(SECTION_POINTS_RE)
      if (ptsM) {
        sectionDefaultPoints = Number(ptsM[1] || ptsM[2])
      }
      continue
    }

    // Standalone star answer marker on its own line: "*C" or "C*"
    const standaloneStar = line.match(/^\s*\*+\s*([a-j])\s*$|^\s*([a-j])\s*\*+\s*$/i)
    if (standaloneStar && current && current.choices.length > 0) {
      const starLetter = standaloneStar[1] || standaloneStar[2]
      const idx = letterIndex(starLetter)
      if (idx < current.choices.length) {
        current.marked = idx
        continue
      }
    }

    // Inline Answer line
    const answer = line.match(ANSWER_RE)
    if (answer && current) {
      current.answer = answer[1].trim()
      continue
    }

    // Question start: "1.", "1)", "(1)", "Q1:", "Item 1."
    const question = line.match(QUESTION_RE)
    if (question && question[2]) {
      let prompt = question[2].trim()
      let points = sectionDefaultPoints ?? (section === "essay" ? 5 : 1)

      const ptsMatch = prompt.match(POINTS_TAG_RE)
      if (ptsMatch) {
        points = Number(ptsMatch[1] || ptsMatch[2])
        prompt = prompt.replace(POINTS_TAG_RE, "").trim()
      }

      const inline = splitInlineQuestionChoices(prompt)
      prompt = inline.prompt
      const markedInlineIndex = inline.choices.findIndex((choice) => stripMark(choice).marked)

      const newBlock: Block = {
        number: Number(question[1]),
        prompt,
        choices: inline.choices.map((choice) => stripMark(choice).text),
        marked: markedInlineIndex >= 0 ? markedInlineIndex : null,
        answer: null,
        section,
        group,
        points,
      }
      current = newBlock
      blocks.push(newBlock)
      continue
    }

    // Multi-choice extraction (handles all-on-1-line and 2x2 grid)
    if (current) {
      const inlineChoices = extractChoicesFromLine(line, current.choices.length)
      if (inlineChoices && inlineChoices.length > 0) {
        for (const item of inlineChoices) {
          const { text, marked } = stripMark(item)
          if (marked) current.marked = current.choices.length
          current.choices.push(text)
        }
        continue
      }
    }

    // Single choice starting at beginning of line: "A.", "b)", "[C]"
    if (current) {
      const choice = line.match(CHOICE_START_RE)
      if (choice) {
        const letter = choice[1] || choice[2]
        if (letter && letterIndex(letter) === current.choices.length && choice[3] !== undefined) {
          const { text, marked } = stripMark(choice[3])
          if (marked) current.marked = current.choices.length
          current.choices.push(text)
          continue
        }
      }

      // Choice marked with star at start: "*C. Green"
      const starred = line.startsWith("*") || line.startsWith("✓")
      if (starred) {
        const afterStar = line.slice(1).trim()
        const sc = afterStar.match(CHOICE_START_RE)
        if (sc) {
          const sl = sc[1] || sc[2]
          if (sl && letterIndex(sl) === current.choices.length && sc[3] !== undefined) {
            const { text } = stripMark(sc[3])
            current.marked = current.choices.length
            current.choices.push(text)
            continue
          }
        }
      }
    }

    // Continuation of prompt or choice
    if (current) {
      if (current.choices.length > 0) {
        const last = current.choices.length - 1
        const { text, marked } = stripMark(line)
        if (marked) current.marked = last
        current.choices[last] = `${current.choices[last]} ${text}`.trim()
      } else {
        const ptsMatch = line.match(POINTS_TAG_RE)
        let contLine = line
        if (ptsMatch) {
          current.points = Number(ptsMatch[1] || ptsMatch[2])
          contLine = line.replace(POINTS_TAG_RE, "").trim()
        }
        if (contLine) {
          current.prompt = `${current.prompt} ${contLine}`.trim()
        }
      }
    }
  }

  for (const block of blocks) {
    if (!block.answer && key.has(block.number)) block.answer = key.get(block.number)!
  }

  if (mode !== "auto") return blocks.map((b) => finish(b, mode))

  // Generalized type detection per question
  return blocks.map((b) => {
    let type: QuestionType = b.section ?? "identification"

    // 1. If choices are present:
    if (b.choices.length >= 2) {
      const isTf =
        b.choices.length === 2 &&
        ((b.choices[0].toLowerCase() === "true" && b.choices[1].toLowerCase() === "false") ||
         (b.choices[0].toLowerCase() === "tama" && b.choices[1].toLowerCase() === "mali"))
      type = isTf ? "true_false" : "multiple_choice"
    }
    // 2. If NO choices are present:
    else {
      if (TRAILING_TF_RE.test(b.prompt) || TF_PREFIX_RE.test(b.prompt) || (b.answer && TF_WORD_RE.test(b.answer))) {
        type = "true_false"
      } else if (b.section && b.section !== "multiple_choice") {
        // Explicit section like essay, identification, etc.
        type = b.section
      } else if (BLANK_IN_PROMPT_RE.test(b.prompt)) {
        type = "identification"
      } else if (ESSAY_PROMPT_RE.test(b.prompt) || (b.points >= 5 && !SHORT_ANSWER_PROMPT_RE.test(b.prompt))) {
        type = "essay"
      } else if (SHORT_ANSWER_PROMPT_RE.test(b.prompt)) {
        type = "identification"
      } else if (!b.section || b.section === "multiple_choice") {
        type = "identification"
      }
    }

    return finish(b, type)
  })
}

/** Document-level passes: normalize and map sections/answer keys before parsing each section in isolation. */
export function parseQuestions(raw: string, mode: PasteMode = "auto"): ParsedQuestion[] {
  const lines = raw
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(/\f/g, "\n")
    .split("\n")
    .map(clean)
    .filter((line) => line && !PAPER_LINE_RE.test(line) && !PAGE_MARKER_RE.test(line))

  type Chunk = { scope: string; lines: string[] }
  const chunks: Chunk[] = [{ scope: "document", lines: [] }]
  const scopedKeys = new Map<string, Map<number, string>>()
  const globalKeys = new Map<number, string>()
  let scope = "document"
  let sectionOrdinal = 0
  let inKey = false

  const collectPairs = (text: string, target: Map<number, string>) => {
    const pairs = [...text.matchAll(new RegExp(KEY_PAIR_RE.source, "g"))]
    for (const pair of pairs) target.set(Number(pair[1]), pair[2].trim())
    if (!pairs.length) {
      const one = text.match(/^\s*(\d{1,3})\s*[.)\-:=]\s*(.+)$/)
      if (one) target.set(Number(one[1]), one[2].trim())
    }
  }

  for (const line of lines) {
    if (HEADER_METADATA_RE.test(line)) continue

    const keyHeader = line.match(KEY_HEADER_RE)
    if (keyHeader) {
      inKey = true
      const tail = keyHeader[1]?.trim() ?? ""
      if (tail) collectPairs(tail, scope === "document" ? globalKeys : getScopedKeys(scope))
      continue
    }

    // Section headings are mapped before question parsing, keeping restarted numbering local.
    const explicitPrefix = line.match(SECTION_PREFIX_RE)
    const typedHeading = parseSection(line)
    const romanHeading = line.match(ROMAN_SECTION_RE)
    const isRomanTitle = romanHeading && (typedHeading || /^[A-Z][A-Z\s/&-]{2,}$/.test(romanHeading[2]))
    if (explicitPrefix || typedHeading || isRomanTitle) {
      sectionOrdinal++
      const headingToken = explicitPrefix?.[2] ?? romanHeading?.[1]
      const headingId = headingToken
        ? `section:${headingToken.toLowerCase()}`
        : `section:${sectionOrdinal}`
      scope = headingId
      chunks.push({ scope, lines: [line] })
      inKey = false
      continue
    }

    if (inKey) {
      collectPairs(line, scope === "document" ? globalKeys : getScopedKeys(scope))
      continue
    }
    chunks[chunks.length - 1].lines.push(line)
  }

  function getScopedKeys(keyScope: string) {
    let map = scopedKeys.get(keyScope)
    if (!map) scopedKeys.set(keyScope, (map = new Map()))
    return map
  }

  // Count repeated question numbers across sections so global keys are only applied unambiguously.
  const numberCounts = new Map<number, number>()
  for (const chunk of chunks) {
    for (const line of chunk.lines) {
      const match = line.match(QUESTION_RE)
      if (match) numberCounts.set(Number(match[1]), (numberCounts.get(Number(match[1])) ?? 0) + 1)
    }
  }

  const result: ParsedQuestion[] = []
  for (const chunk of chunks) {
    if (!chunk.lines.length) continue
    const localKeys = scopedKeys.get(chunk.scope)
    const answerLines = new Map<number, string>()
    for (const [number, answer] of globalKeys) {
      if (numberCounts.get(number) === 1) answerLines.set(number, answer)
    }
    localKeys?.forEach((answer, number) => answerLines.set(number, answer))
    const keyText = [...answerLines].map(([number, answer]) => `${number}. ${answer}`)
    const sectionText = chunk.lines.join("\n")
    // Inline answer keys at the end let the existing question analyzer stay focused on one section.
    result.push(...parseQuestionsOneSection(
      keyText.length ? `${sectionText}\nAnswer Key:\n${keyText.join("\n")}` : sectionText,
      mode,
    ))
  }
  return result
}
