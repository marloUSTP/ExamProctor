import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { PGlite } from "@electric-sql/pglite"
import ts from "typescript"

// All identities are synthetic fixtures inside an isolated PostgreSQL engine.
const db = new PGlite()
const teacher = "11111111-1111-4111-8111-111111111111"
const exam = "33333333-3333-4333-8333-333333333333"
const scalar = async (sql, params = []) => Object.values((await db.query(sql, params)).rows[0])[0]
const join = (email, first, last, code = "JOIN01") => scalar("select public.student_join($1,$2,$3,$4)", [code, email, first, last])
const legacyJoin = (email, name, code = "JOIN01") => scalar("select public.student_join($1,$2,$3)", [code, email, name])
const findOrContinue = (email, code = "JOIN01") => scalar("select public.student_join($1,$2)", [code, email])
const reject = (operation, pattern) => assert.rejects(operation, pattern)

try {
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
    alter default privileges in schema public grant all on tables to anon, authenticated;
    create publication supabase_realtime;
  `)
  // Use the pre-registration schema to verify upgrading real legacy rows.
  const schema = readFileSync("supabase/schema.sql", "utf8").split("-- BEGIN STUDENT NAME REGISTRATION")[0]
  await db.exec(schema)
  await db.query("insert into auth.users values ($1)", [teacher])
  await db.query("insert into public.teachers(user_id) values ($1)", [teacher])
  await db.query("insert into public.exams(id,teacher_id,title,code,status) values($1,$2,'Registration test','JOIN01','open')", [exam, teacher])
  await db.exec("set role anon")
  const previous = await legacyJoin("old@example.com", "Mary Ann  Dela Cruz")
  await db.exec("reset role")
  const priorSession = await scalar("select session_id from public.session_tokens where token=$1", [previous.token])
  await db.query("update public.exam_sessions set status='in_progress',violation_count=2,attempt=3,started_at=now() where id=$1", [priorSession])
  const question = await scalar("insert into public.questions(exam_id,type,prompt) values($1,'identification','Example') returning id", [exam])
  await db.query("insert into public.answers(session_id,question_id,answer) values($1,$2,'Saved answer')", [priorSession, question])
  const migration = readFileSync("supabase/migrations/20261015110000_student_name_registration.sql", "utf8")
  await db.exec(migration)
  await db.exec(migration) // Safe to apply again during staged deployments.
  await db.exec(readFileSync("supabase/migrations/20261015120000_email_only_exam_continue.sql", "utf8"))
  await db.exec(readFileSync("supabase/migrations/20261015130000_uppercase_student_names.sql", "utf8"))
  assert.equal(await scalar("select student_first_name from public.exam_sessions where id=$1", [priorSession]), null, "legacy names are not guessed")
  await db.exec("set role anon")
  assert.equal((await findOrContinue(" OLD@example.com ")).token, previous.token, "email and code alone resume an existing legacy attempt")
  assert.deepEqual(await findOrContinue("not-yet@example.com"), { registration_required: true, code: "JOIN01" })
  assert.deepEqual(await findOrContinue("not-yet@example.com"), { registration_required: true, code: "JOIN01" })
  await db.exec("reset role")
  assert.equal(Number(await scalar("select count(*) from public.exam_sessions where student_email='not-yet@example.com'")), 0, "email lookup never registers a student")
  await db.exec("set role anon")
  const resumed = await join(" OLD@example.com ", "  mary   ann ", " DELA  cruz ")
  assert.equal(resumed.token, previous.token, "same identity resumes the original token")
  await reject(() => join("new-email@example.com", "MARY ANN", "dela cruz"), /DUPLICATE_STUDENT/)
  await reject(() => legacyJoin("another-email@example.com", "mary ann dela cruz"), /DUPLICATE_STUDENT/)
  await reject(() => join("old@example.com", "Mary", "Dela Cruz"), /NAME_MISMATCH/)
  await reject(() => join("old@example.com", "Mary", "Ann Dela Cruz"), /NAME_MISMATCH/)
  await db.exec("reset role")
  const retained = (await db.query("select status,violation_count,attempt,student_name,student_first_name,student_last_name from public.exam_sessions where id=$1", [priorSession])).rows[0]
  assert.deepEqual(retained, { status: "in_progress", violation_count: 2, attempt: 3, student_name: "Mary Ann  Dela Cruz", student_first_name: "MARY ANN", student_last_name: "DELA CRUZ" })
  assert.equal(await scalar("select answer from public.answers where session_id=$1", [priorSession]), "Saved answer")
  assert.equal(Number(await scalar("select count(*) from public.session_events where session_id=$1 and type='join_requested'", [priorSession])), 1)

  await db.exec("set role anon")
  const registered = await join(" Juan@example.com ", " Juan ", "Dela  Cruz")
  assert.equal((await findOrContinue("JUAN@example.com", " join01 ")).token, registered.token)
  assert.equal((await join("juan@example.com", "JUAN", "dela cruz")).token, registered.token)
  assert.equal((await legacyJoin("juan@example.com", "juan DELA CRUZ")).token, registered.token, "old client can resume a new registration")
  await reject(() => join("duplicate@example.com", "juan", "DELA CRUZ"), /DUPLICATE_STUDENT/)
  await reject(() => join("split-duplicate@example.com", "Juan Dela", "Cruz"), /DUPLICATE_STUDENT/)
  await reject(() => legacyJoin("duplicate@example.com", " JUAN  Dela Cruz "), /DUPLICATE_STUDENT/)
  await reject(() => join("juan@example.com", "Different", "Person"), /NAME_MISMATCH/)
  await reject(() => join("empty@example.com", "   ", "Cruz"), /INVALID_NAME/)
  await reject(() => join("empty@example.com", "Juan", "   "), /INVALID_NAME/)
  await reject(() => join("invalid-email", "Other", "Person"), /INVALID_EMAIL/)
  await reject(() => findOrContinue("invalid-email"), /INVALID_EMAIL/)
  await reject(() => findOrContinue("juan@example.com", "BAD000"), /EXAM_NOT_FOUND/)
  await reject(() => join("long@example.com", "A".repeat(60), "B".repeat(60)), /INVALID_NAME/)
  await reject(() => join("long@example.com", "A".repeat(61), "B"), /INVALID_NAME/)
  const unicode = await join("unicode@example.com", "José", "O'Neill-Santos")
  assert.equal((await join("unicode@example.com", "JOSÉ", "o'neill-santos")).token, unicode.token)
  // Rapid duplicate requests: one entry and one join_requested event survive.
  const parallel = await Promise.allSettled([
    join("rapid1@example.com", "Rapid", "Student"),
    join("rapid2@example.com", "RAPID", "STUDENT"),
  ])
  assert.equal(parallel.filter((r) => r.status === "fulfilled").length, 1)
  assert.match(parallel.find((r) => r.status === "rejected").reason.message, /DUPLICATE_STUDENT/)
  await reject(() => db.query("select public.student_join_identity('JOIN01','x@example.com','X Y',null,null)"), /permission denied/)
  await db.exec("reset role")
  assert.equal(Number(await scalar("select count(*) from public.exam_sessions where exam_id=$1 and lower(student_name)='rapid student'", [exam])), 1)
  const registeredId = await scalar("select session_id from public.session_tokens where token=$1", [registered.token])
  assert.deepEqual((await db.query("select student_name, student_first_name, student_last_name from public.exam_sessions where id=$1", [registeredId])).rows[0], {
    student_name: "JUAN DELA CRUZ", student_first_name: "JUAN", student_last_name: "DELA CRUZ",
  }, "mixed-case RPC input is saved in uppercase on the server")
  await db.exec("set role anon")
  const legacyNew = await legacyJoin("legacy-new@example.com", "  Anne-Marie   O'Neill ")
  await db.exec("reset role")
  assert.equal(await scalar("select s.student_name from public.exam_sessions s join public.session_tokens t on t.session_id=s.id where t.token=$1", [legacyNew.token]), "ANNE-MARIE O'NEILL", "older registration clients also save uppercase")
  for (const status of ["pending", "approved", "rejected", "submitted", "auto_submitted"]) {
    await db.query("update public.exam_sessions set status=$1 where id=$2", [status, registeredId])
    await db.exec("set role anon")
    assert.equal((await join("juan@example.com", "juan", "Dela Cruz")).token, registered.token)
    assert.equal((await findOrContinue("juan@example.com")).token, registered.token)
    await db.exec("reset role")
    assert.equal(await scalar("select status from public.exam_sessions where id=$1", [registeredId]), status)
  }
  await db.query("update public.exams set status='closed' where id=$1", [exam])
  await db.exec("set role anon")
  assert.equal((await join("juan@example.com", "Juan", "Dela Cruz")).token, registered.token, "closed exams still allow existing identities to resume")
  assert.equal((await findOrContinue("juan@example.com")).token, registered.token, "email-only continuation also works for a closed exam")
  await reject(() => findOrContinue("fresh@example.com"), /EXAM_NOT_OPEN/)
  await reject(() => join("fresh@example.com", "Fresh", "Student"), /EXAM_NOT_OPEN/)
  await db.exec("reset role")
  const examTwo = await scalar("insert into public.exams(teacher_id,title,code,status) values($1,'Second exam','JOIN02','open') returning id", [teacher])
  await db.exec("set role anon")
  const anotherExam = await join("juan@example.com", "Juan", "Dela Cruz", "JOIN02")
  assert.notEqual(anotherExam.token, registered.token, "same names can register in different exams")
  await db.exec("reset role")
  await db.query("update public.exams set status='draft',scheduled_start_at=now()+interval '1 hour',scheduled_end_at=now()+interval '2 hours' where id=$1", [examTwo])
  await db.exec("set role anon")
  await join("scheduled@example.com", "Scheduled", "Student", "JOIN02")
  await db.exec("reset role")
  await db.query("update public.exams set scheduled_start_at=now()-interval '2 hours',scheduled_end_at=now()-interval '1 hour' where id=$1", [examTwo])
  await db.exec("set role anon")
  await reject(() => join("expired@example.com", "Expired", "Student", "JOIN02"), /EXAM_NOT_OPEN/)
  await reject(() => findOrContinue("expired@example.com", "JOIN02"), /EXAM_NOT_OPEN/)
  await db.exec("reset role")

  const compiled = ts.transpileModule(readFileSync("src/lib/student-name.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.ES2022 } }).outputText
  const { studentNameParts } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`)
  assert.deepEqual(studentNameParts("  Mary   Ann ", " Dela  Cruz "), { firstName: "MARY ANN", lastName: "DELA CRUZ" })
  assert.throws(() => studentNameParts(" ", "Cruz"), /first name/)
  assert.throws(() => studentNameParts("Juan", " "), /last name/)
  assert.throws(() => studentNameParts("A".repeat(60), "B".repeat(60)), /120/)
  assert.deepEqual(studentNameParts("José", "O'Neill-Santos"), { firstName: "JOSÉ", lastName: "O'NEILL-SANTOS" })
  console.log("PASS: email-only continuation, registration lookup without inserts, separate names, duplicate prevention, legacy clients, preserved attempts and exam boundaries.")
} catch (error) {
  console.error("FAIL:", error.message, error.where ?? "")
  process.exitCode = 1
} finally { await db.close() }
