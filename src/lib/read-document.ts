/** Read selectable text locally; original documents are never uploaded. */
export async function readDocument(file: File): Promise<string> {
  if (file.size > 20 * 1024 * 1024) throw new Error("Choose a file smaller than 20 MB.")
  const extension = file.name.toLowerCase().split(".").pop()
  let text = ""
  if (extension === "txt") {
    text = await file.text()
  } else if (extension === "docx") {
    const mammoth = await import("mammoth")
    text = (await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })).value
  } else if (extension === "pdf") {
    const pdfjs = await import("pdfjs-dist")
    pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs"
    const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) })
    const pages: string[] = []
    try {
      const document = await task.promise
      for (let n = 1; n <= document.numPages; n++) {
        const page = await document.getPage(n)
        const content = await page.getTextContent()
        let line = ""
        let y: number | null = null
        const lines: string[] = []
        const finish = () => { if (line.trim()) lines.push(line.trim()); line = ""; y = null }
        for (const item of content.items) {
          if (!("str" in item) || !item.str.trim()) continue
          const nextY = item.transform?.[5]
          if (line && nextY !== undefined && y !== null && Math.abs(nextY - y) > 2.5) finish()
          line = line ? `${line} ${item.str}` : item.str
          if (nextY !== undefined) y = nextY
          if (item.hasEOL) finish()
        }
        finish()
        pages.push(lines.join("\n"))
        page.cleanup()
      }
    } finally { await task.destroy() }
    text = pages.join("\n\n")
  } else throw new Error("Choose a .docx, text-based PDF, or .txt file.")
  if (!text.trim()) throw new Error("No selectable text was found. Scanned or image-only PDFs aren't supported.")
  return text.trim()
}
