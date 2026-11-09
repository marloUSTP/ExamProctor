import type { Metadata } from "next"
import { CheckScore } from "@/components/student/check-score"

export const metadata: Metadata = { title: "Check my score · Exam Proctor" }

export default function ResultsPage() {
  return <CheckScore />
}
