import { ExamRoom } from "@/components/student/exam-room"

export default async function ExamPage({ params }: PageProps<"/exam/[code]">) {
  const { code } = await params
  return <ExamRoom code={code.toUpperCase()} />
}
