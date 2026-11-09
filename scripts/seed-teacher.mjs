import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
const username = (process.env.TEACHER_USERNAME || "p3lep404").trim().toLowerCase()
const password = process.env.TEACHER_PASSWORD

if (!supabaseUrl || !serviceRoleKey || !password) {
  console.error(
    "Set SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL), SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY), and TEACHER_PASSWORD in .env.local before running this script."
  )
  process.exit(1)
}

const email = username.includes("@") ? username : `${username}@exam-proctor.local`
const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
})

let user
const { data: listed, error: listError } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 })
if (listError) throw listError
user = listed.users.find((candidate) => candidate.email?.toLowerCase() === email)

if (!user) {
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  if (error) throw error
  user = data.user
}

const { error: teacherError } = await supabase
  .from("teachers")
  .upsert({ user_id: user.id }, { onConflict: "user_id" })
if (teacherError) throw teacherError

console.log(`Teacher account is ready. Sign in with username: ${username}`)
console.log(`Auth email: ${email}`)
