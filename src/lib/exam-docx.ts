import JSZip from "jszip"
import type { Question, QuestionType } from "@/lib/types"

/**
 * Builds the printable test paper (.docx) from public/templates/exam-paper.docx.
 *
 * The template holds the school header, the Name/Date/Instructor table and the fonts; its body has a
 * {{EXAM_CONTENT}} paragraph where the questions go. To change the letterhead, edit the template in Word
 * and keep that placeholder line.
 *
 * Questions keep the teacher's order (consecutive questions of one type share a section heading) and
 * numbering runs straight through all sections. Multiple-choice options are shuffled on every export;
 * the answer key on the last page follows the shuffled letters.
 */

export const TEMPLATE_URL = "/templates/exam-paper.docx"
const PLACEHOLDER = /<w:p\b[^>]*>(?:(?!<\/w:p>)[\s\S])*\{\{EXAM_CONTENT\}\}(?:(?!<\/w:p>)[\s\S])*<\/w:p>/

const SECTIONS: Record<QuestionType, { title: string; directions: string; strict: string }> = {
  multiple_choice: {
    title: "Multiple Choice:",
    directions: " Choose the BEST answer for the following questions. Circle the letter of the correct answer. ",
    strict: "STRICTLY NO ERASURE!",
  },
  true_false: {
    title: "TRUE OR FALSE:",
    directions:
      " Write TRUE if the statement is correct and FALSE if the statement is incorrect before the number of each item. ",
    strict: "STRICTLY NO ERASURE",
  },
  identification: {
    title: "IDENTIFICATION:",
    directions: " Write the correct answer on the space provided before the number of each item. ",
    strict: "STRICTLY NO ERASURE.",
  },
  essay: {
    title: "ESSAY / SCENARIO-BASED:",
    directions: " Explain and support your answers clearly. Write your responses in the space provided. ",
    strict: "STRICTLY NO ERASURE.",
  },
}

const KEY_TITLES: Record<QuestionType, string> = {
  multiple_choice: "Multiple Choice",
  true_false: "True or False",
  identification: "Identification",
  essay: "Essay",
}

const LETTERS = "abcdefghij"

/* ---------- XML helpers (Cambria 8pt, like the template) ---------- */

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

function run(text: string, bold = false) {
  const rPr = `<w:rPr><w:rFonts w:ascii="Cambria" w:hAnsi="Cambria" w:cs="Times New Roman"/>${
    bold ? "<w:b/><w:bCs/>" : ""
  }<w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr>`
  // Line breaks inside a prompt stay inside the same numbered item.
  const body = text
    .split(/\r?\n/)
    .map((line) => `<w:t xml:space="preserve">${esc(line)}</w:t>`)
    .join("<w:br/>")
  return `<w:r>${rPr}${body}</w:r>`
}

function para(runs: string, opts: { numId?: number; ind?: number; after?: number; jc?: string; pageBreak?: boolean } = {}) {
  const pPr = [
    `<w:pStyle w:val="NoSpacing"/>`,
    opts.pageBreak ? "<w:pageBreakBefore/>" : "",
    opts.numId ? `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${opts.numId}"/></w:numPr>` : "",
    `<w:spacing w:after="${opts.after ?? 0}" w:line="276" w:lineRule="auto"/>`,
    opts.ind ? `<w:ind w:left="${opts.ind}"/>` : "",
    opts.jc ? `<w:jc w:val="${opts.jc}"/>` : "",
  ].join("")
  return `<w:p><w:pPr>${pPr}</w:pPr>${runs}</w:p>`
}

const blank = () => para("")

/** A grid of `cols` answers per row, used for the multiple-choice and true/false keys. */
function keyTable(cells: string[], cols = 5) {
  const width = Math.floor(9026 / cols)
  const grid = `<w:tblGrid>${`<w:gridCol w:w="${width}"/>`.repeat(cols)}</w:tblGrid>`
  const rows: string[] = []
  for (let i = 0; i < cells.length; i += cols) {
    const tcs = Array.from({ length: cols }, (_, c) => {
      const text = cells[i + c] ?? ""
      return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/></w:tcPr>${para(text ? run(text) : "")}</w:tc>`
    }).join("")
    rows.push(`<w:tr>${tcs}</w:tr>`)
  }
  return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="${width * cols}" w:type="dxa"/><w:tblLook w:val="04A0"/></w:tblPr>${grid}${rows.join("")}</w:tbl>`
}

/* ---------- Numbering: one list for the question numbers, a fresh a–d list per multiple-choice item ---------- */

function addNumbering(numberingXml: string, choiceLists: number) {
  const maxId = (re: RegExp) => Math.max(0, ...[...numberingXml.matchAll(re)].map((m) => Number(m[1])))
  const absQ = maxId(/w:abstractNumId="(\d+)"/g) + 1
  const absC = absQ + 1
  const firstNum = maxId(/<w:num w:numId="(\d+)"/g) + 1

  const level = (fmt: string, left: number) =>
    `<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${left}" w:hanging="360"/></w:pPr><w:rPr><w:rFonts w:ascii="Cambria" w:hAnsi="Cambria"/><w:b w:val="0"/><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr></w:lvl>`
  const abstracts =
    `<w:abstractNum w:abstractNumId="${absQ}"><w:multiLevelType w:val="singleLevel"/>${level("decimal", 360)}</w:abstractNum>` +
    `<w:abstractNum w:abstractNumId="${absC}"><w:multiLevelType w:val="singleLevel"/>${level("lowerLetter", 720)}</w:abstractNum>`

  const questionNum = firstNum
  const choiceNums = Array.from({ length: choiceLists }, (_, i) => firstNum + 1 + i)
  const nums =
    `<w:num w:numId="${questionNum}"><w:abstractNumId w:val="${absQ}"/></w:num>` +
    choiceNums
      .map(
        (id) =>
          `<w:num w:numId="${id}"><w:abstractNumId w:val="${absC}"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`
      )
      .join("")

  // Schema order: every <w:abstractNum> comes before the first <w:num>.
  const firstNumAt = numberingXml.search(/<w:num\b/)
  const withAbstracts =
    firstNumAt === -1
      ? numberingXml.replace("</w:numbering>", abstracts + "</w:numbering>")
      : numberingXml.slice(0, firstNumAt) + abstracts + numberingXml.slice(firstNumAt)
  return { xml: withAbstracts.replace("</w:numbering>", nums + "</w:numbering>"), questionNum, choiceNums }
}

/* ---------- Content ---------- */

function shuffledOrder(n: number) {
  const order = Array.from({ length: n }, (_, i) => i)
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[order[i], order[j]] = [order[j], order[i]]
  }
  return order
}

interface Section {
  type: QuestionType
  items: { number: number; question: Question; choices: string[]; key: string }[]
}

function buildSections(questions: Question[]): Section[] {
  const sections: Section[] = []
  questions.forEach((q, i) => {
    let choices: string[] = []
    let key: string
    if (q.type === "multiple_choice") {
      const filled = q.choices.map((c, idx) => ({ c, idx })).filter((x) => x.c.trim() !== "")
      const order = shuffledOrder(filled.length).map((k) => filled[k])
      choices = order.map((x) => x.c)
      const at = order.findIndex((x) => String(x.idx) === q.correct_answers[0])
      key = at === -1 ? "—" : LETTERS[at]
    } else if (q.type === "true_false") {
      key = q.correct_answers[0] === "true" ? "TRUE" : q.correct_answers[0] === "false" ? "FALSE" : "—"
    } else {
      key = q.correct_answers.filter((a) => a.trim()).join(" / ") || "—"
    }
    const last = sections[sections.length - 1]
    const item = { number: i + 1, question: q, choices, key }
    if (last?.type === q.type) last.items.push(item)
    else sections.push({ type: q.type, items: [item] })
  })
  return sections
}

function buildBody(sections: Section[], title: string, questionNum: number, choiceNums: number[]) {
  const out: string[] = []
  let choiceList = 0

  sections.forEach((section, s) => {
    if (s > 0) out.push(blank())
    const head = SECTIONS[section.type]
    out.push(para(run(head.title, true) + run(head.directions) + run(head.strict, true), { after: 160, jc: "both" }))
    for (const item of section.items) {
      out.push(para(run(item.question.prompt), { numId: questionNum, jc: "both" }))
      if (section.type === "multiple_choice") {
        const numId = choiceNums[choiceList++]
        for (const choice of item.choices) out.push(para(run(choice), { numId }))
      }
    }
  })

  // Answer key on its own page.
  out.push(para(run("ANSWER KEY", true), { pageBreak: true, jc: "center" }))
  out.push(para(run(title), { jc: "center", after: 160 }))
  sections.forEach((section, s) => {
    if (s > 0) out.push(blank())
    const first = section.items[0].number
    const last = section.items[section.items.length - 1].number
    out.push(para(run(`${KEY_TITLES[section.type]} (${first}–${last})`, true), { after: 80 }))
    if (section.type === "identification") {
      for (const item of section.items) out.push(para(run(`${item.number}. ${item.key}`)))
    } else {
      out.push(keyTable(section.items.map((item) => `${item.number}. ${item.key}`)))
    }
  })
  return out.join("")
}

export async function buildExamDocx(template: ArrayBuffer, title: string, questions: Question[]): Promise<Blob> {
  const zip = await JSZip.loadAsync(template)
  const docFile = zip.file("word/document.xml")
  const numFile = zip.file("word/numbering.xml")
  if (!docFile || !numFile) throw new Error("The Word template is missing its document or numbering part.")

  const sections = buildSections([...questions].sort((a, b) => a.position - b.position))
  const mcCount = sections.flatMap((s) => s.items).filter((i) => i.question.type === "multiple_choice").length
  const numbering = addNumbering(await numFile.async("string"), mcCount)

  const doc = await docFile.async("string")
  if (!PLACEHOLDER.test(doc)) throw new Error("The Word template has no {{EXAM_CONTENT}} line.")
  const body = buildBody(sections, title, numbering.questionNum, numbering.choiceNums)

  zip.file("word/document.xml", doc.replace(PLACEHOLDER, () => body))
  zip.file("word/numbering.xml", numbering.xml)
  return zip.generateAsync({
    type: "blob",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    compression: "DEFLATE",
  })
}
