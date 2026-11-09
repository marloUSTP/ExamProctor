import { copyFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const worker = path.join(root, "node_modules", "pdfjs-dist", "build", "pdf.worker.min.mjs")
const publicDir = path.join(root, "public")

await mkdir(publicDir, { recursive: true })
await copyFile(worker, path.join(publicDir, "pdf.worker.min.mjs"))
