import "server-only"

import { AiError, generateJson, type JsonSchema } from "./ai-providers"
import { MAX_RUBRIC_TEXT, validateGrading, validateRubric } from "./rubric"
import type { Question, Rubric } from "./types"

const object = (properties: Record<string, JsonSchema>): JsonSchema => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false })
const string = { type: "string" }
const rubricSchema = object({ criteria: {
  // An empty result lets the model decline extraction instead of inventing criteria.
  type: "array", minItems: 0, maxItems: 12,
  items: object({ id: string, name: string, description: string, max_points: { type: "number" } }),
} })
const gradingSchema = object({
  criteria: { type: "array", items: object({ criterion_id: string, points: { type: "number" }, reason: string, evidence: string }) },
  feedback: string,
})

export async function extractRubric(source: string, points: number) {
  if (!source.trim() || source.length > MAX_RUBRIC_TEXT) throw new AiError("Paste or upload a rubric of up to 30,000 characters.", 400)
  const { value } = await generateJson(
    "Extract an assessment rubric from the document. Preserve its actual criteria, point limits, and performance-level descriptions, including level-to-score mappings. Do not invent missing scoring rules or silently rescale points to the question maximum. Use short unique alphanumeric IDs. If the document lacks explicit criteria with numeric maxima, return an empty criteria array. Descriptions must be concise, faithful, and at most 4,000 characters; names at most 200. The teacher will review this draft before saving.",
    { rubric_document: source, question_maximum: points }, rubricSchema,
  )
  try { return validateRubric(value) }
  catch { throw new AiError("Could not extract a valid rubric with point limits. Add or correct the criteria manually.", 422) }
}

export async function gradeEssay(question: Pick<Question, "prompt" | "points"> & { rubric: Rubric }, answer: string) {
  const rubric = validateRubric(question.rubric, question.points)
  const { value, provider, model } = await generateJson(
    "Suggest criterion-by-criterion essay scores using ONLY the supplied assessment question and teacher rubric. Apply the performance-level descriptions consistently, allowing partial credit where justified. Never exceed a criterion maximum. Return every criterion ID exactly once, a concise reason for its points, and a short verbatim substring from the answer as evidence (or an empty string when there is no supporting text). Do not fabricate quotations. Blank or irrelevant answers earn zero. Explain missing requirements and give brief constructive overall feedback. Reasons and evidence must each be at most 2,000 characters; feedback at most 4,000. These are provisional suggestions requiring teacher approval.",
    { question: question.prompt, question_points: question.points, rubric, student_answer: answer }, gradingSchema,
  )
  try { return { grading: validateGrading(value, rubric, answer), model: `${provider}:${model}` } }
  catch { throw new AiError("AI returned scores or quoted evidence that did not pass validation. Enter scores manually or try again.", 422) }
}
