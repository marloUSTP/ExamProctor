import { JoinForm } from "@/components/student/join-form"

// Teachers can share /join?code=ABC123 so the code is filled in.
export default async function JoinPage({ searchParams }: PageProps<"/join">) {
  const { code } = await searchParams
  return <JoinForm initialCode={typeof code === "string" ? code : ""} />
}
