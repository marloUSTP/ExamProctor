import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { PGlite } from "@electric-sql/pglite"
import ts from "typescript"

// Exercise the real SQL and RLS in an isolated PostgreSQL engine. No live data,
// credentials, AI service, or running Supabase project is used by these tests.
const db = new PGlite()
const teacher = "11111111-1111-4111-8111-111111111111"
const other = "22222222-2222-4222-8222-222222222222"
const exam = "33333333-3333-4333-8333-333333333333"
const essay = "44444444-4444-4444-8444-444444444444"
const mcq = "55555555-5555-4555-8555-555555555555"
const student = "66666666-6666-4666-8666-666666666666"
const blankStudent = "77777777-7777-4777-8777-777777777777"
const rubric = { criteria: [
  { id: "content", name: "Content", description: "6: complete; 3: partial; 0: missing.", max_points: 6 },
  { id: "evidence", name: "Evidence", description: "4: supported; 2: weak; 0: absent.", max_points: 4 },
] }
const grading = { criteria: [
  { criterion_id: "content", points: 4, reason: "Partial explanation", evidence: "Encryption" },
  { criterion_id: "evidence", points: 2, reason: "Needs a concrete example", evidence: "" },
], feedback: "Explain your example." }
const snapshot = { prompt: "Explain encryption.", points: 10, rubric }
const scalar = async (sql, params = []) => Object.values((await db.query(sql, params)).rows[0])[0]
async function reject(sql, params, expected) {
  await assert.rejects(() => db.query(sql, params), expected)
}

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
  const base = readFileSync("supabase/schema.sql", "utf8").split("-- BEGIN RUBRIC GRADING SETUP")[0]
  await db.exec(base)
  await db.exec(readFileSync("supabase/migrations/20261008130000_manual_partial_credit.sql", "utf8"))
  await db.query("insert into auth.users values ($1), ($2)", [teacher, other])
  await db.query("insert into public.teachers(user_id) values ($1), ($2)", [teacher, other])
  await db.query("insert into public.exams(id, teacher_id, title, status) values ($1,$2,'Grading test','closed')", [exam, teacher])
  await db.query("insert into public.questions(id,exam_id,type,prompt,points) values ($1,$2,'essay','Explain encryption.',10)", [essay, exam])
  await db.query("insert into public.questions(id,exam_id,type,prompt,points,choices,correct_answers) values ($1,$2,'multiple_choice','Select B',2,'[\"A\",\"B\"]',array['1'])", [mcq, exam])
  await db.query("insert into public.exam_sessions(id,exam_id,student_name,student_email,status) values ($1,$2,'Student','s@example.com','submitted'),($3,$2,'Blank','b@example.com','auto_submitted')", [student, exam, blankStudent])
  await db.query("insert into public.answers(session_id,question_id,answer,overridden,manual_points,points_awarded) values ($1,$2,'Encryption protects data.',true,7,7)", [student, essay])
  await db.query("insert into public.answers(session_id,question_id,answer) values ($1,$2,'1')", [student, mcq])
  // Reproduce the exact 42703 error reported by an older online database.
  await db.exec("alter table public.exams drop column results_hidden")
  await reject("select public.session_state_json($1)", [student], /record "e" has no field "results_hidden"/)
  const repair = readFileSync("supabase/migrations/20261015090000_repair_results_hidden.sql", "utf8")
  await db.exec(repair)
  assert.ok(await scalar("select public.session_state_json($1)", [student]), "repair restores student state")
  await db.query("update public.exams set results_hidden=true where id=$1", [exam])
  await db.exec(repair)
  assert.equal(await scalar("select results_hidden from public.exams where id=$1", [exam]), true, "rerunning repair preserves hidden results")
  // The rubric upgrade also repairs its prerequisite without a separate step.
  await db.exec("alter table public.exams drop column results_hidden")
  await db.exec(readFileSync("supabase/migrations/20261014090000_rubric_essay_grading.sql", "utf8"))
  await db.exec(readFileSync("supabase/migrations/20261018100000_gemini_teacher_requests.sql", "utf8"))
  assert.equal(Number(await scalar("select score from public.exam_sessions where id=$1", [student])), 9, "upgrade preserves prior partial grades")
  assert.equal(await scalar("select score from public.exam_sessions where id=$1", [blankStudent]), null, "blank essays await approval")
  assert.equal(await scalar("select public.session_needs_grading($1)", [blankStudent]), true)

  await db.exec("set role authenticated")
  await db.query("select set_config('request.jwt.claim.sub','',false)")
  await reject("select public.teacher_claim_ai_request()", [], /FORBIDDEN/)
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [teacher])
  const lease = await scalar("select public.teacher_claim_ai_request()")
  await reject("select public.teacher_claim_ai_request()", [], /AI_RATE_LIMIT/)
  await reject("select * from public.teacher_ai_limits", [], /permission denied/)
  await db.query("select public.teacher_release_ai_request($1)", [other])
  await reject("select public.teacher_claim_ai_request()", [], /AI_RATE_LIMIT/)
  await db.query("select public.teacher_release_ai_request($1)", [lease])
  for (let i = 1; i < 10; i++) {
    const token = await scalar("select public.teacher_claim_ai_request()")
    await db.query("select public.teacher_release_ai_request($1)", [token])
  }
  await reject("select public.teacher_claim_ai_request()", [], /AI_RATE_LIMIT/)
  await db.exec("reset role")
  await db.query("update public.teacher_ai_limits set window_start = clock_timestamp() - interval '2 minutes' where teacher_id=$1", [teacher])
  await db.exec("set role authenticated")
  const renewed = await scalar("select public.teacher_claim_ai_request()")
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [other])
  await db.query("select public.teacher_release_ai_request($1)", [renewed])
  const otherLease = await scalar("select public.teacher_claim_ai_request()")
  await db.query("select public.teacher_release_ai_request($1)", [otherLease])
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [teacher])
  await reject("select public.teacher_claim_ai_request()", [], /AI_RATE_LIMIT/)
  await db.exec("reset role")
  await db.query("update public.teacher_ai_limits set lease_until = clock_timestamp() - interval '1 second' where teacher_id=$1", [teacher])
  await db.exec("set role authenticated")
  const recovered = await scalar("select public.teacher_claim_ai_request()")
  await db.query("select public.teacher_release_ai_request($1)", [recovered])
  await reject("update public.questions set rubric=$1 where id=$2", [{ criteria: [rubric.criteria[0]] }, essay], /INVALID_RUBRIC/)
  await db.query("update public.questions set rubric=$1, rubric_source_text='Original rubric text' where id=$2", [rubric, essay])
  assert.equal(await scalar("select score from public.exam_sessions where id=$1", [student]), null, "rubric change invalidates prior approval")
  await db.exec("reset role")
  let state = await scalar("select public.session_state_json($1)", [student])
  assert.equal(state.result, null, "closed exams do not publish pending grades")
  assert.equal(state.session.grading_pending, true)
  assert.ok(state.review.every((r) => !("points_awarded" in r)), "pending results do not leak per-question points")

  // Upgrading restores released partial scores without publishing draft essay marks.
  const partialRelease = readFileSync("supabase/migrations/20261029090000_release_partial_student_scores.sql", "utf8")
  await db.exec(partialRelease)
  await db.exec(partialRelease) // Repair can safely be applied again.
  state = await scalar("select public.session_state_json($1)", [student])
  assert.equal(Number(state.result.score), 2, "closed exams publish already-graded points")
  assert.equal(Number(state.result.max_score), 12)
  assert.equal(state.result.is_partial, true)
  assert.equal(state.result.pending_questions, 1)
  assert.equal(state.review.find((q) => q.question_id === essay).grading_pending, true)
  assert.equal(state.review.find((q) => q.question_id === essay).points_awarded, null, "an ungraded essay is not a zero")
  assert.equal(state.review.find((q) => q.question_id === mcq).points_awarded, 2)
  assert.equal(await scalar("select score from public.exam_sessions where id=$1", [student]), null, "partial display never finalizes the stored grade")
  await db.query("update public.exams set status='open',results_released=false where id=$1", [exam])
  state = await scalar("select public.session_state_json($1)", [student])
  assert.equal(state.result, null, "open unreleased exams still conceal scores")
  assert.ok(state.review.every((q) => !("points_awarded" in q) && !("correct_answers" in q)))
  await db.query("update public.exams set results_released=true where id=$1", [exam])
  await db.query("update public.exam_sessions set result_code='R-TEST01',deduction=1 where id=$1", [student])
  const examCode = await scalar("select code from public.exams where id=$1", [exam])
  await db.exec("set role anon")
  state = await scalar("select public.student_lookup_result($1,'s@example.com','R-TEST01')", [examCode])
  assert.equal(Number(state.result.score), 1, "early released lookups include deductions in the partial score")
  await db.exec("reset role")
  await db.query("update public.exam_sessions set deduction=5 where id=$1", [student])
  state = await scalar("select public.session_state_json($1)", [student])
  assert.equal(Number(state.result.score), 0, "partial scores cannot become negative")
  await db.query("update public.exam_sessions set deduction=0 where id=$1", [student])
  await db.query("update public.exams set results_hidden=true where id=$1", [exam])
  state = await scalar("select public.session_state_json($1)", [student])
  assert.equal(state.result, null, "hide overrides an explicit release")
  assert.ok(state.review.every((q) => !("points_awarded" in q) && !("rubric_feedback" in q)))
  await db.query("update public.exams set results_hidden=false,results_released=false,scheduled_start_at=now()-interval '1 hour',scheduled_end_at=now()-interval '1 minute' where id=$1", [exam])
  state = await scalar("select public.session_state_json($1)", [student])
  assert.equal(state.result.is_partial, true, "deadline releases partial results automatically")
  await db.query("update public.exams set status='closed',scheduled_start_at=null,scheduled_end_at=null where id=$1", [exam])
  const extraEssay = "88888888-8888-4888-8888-888888888888"
  await db.query("insert into public.questions(id,exam_id,type,prompt,points) values($1,$2,'essay','Another essay',2)", [extraEssay, exam])
  state = await scalar("select public.session_state_json($1)", [student])
  assert.equal(state.result.pending_questions, 2, "missing essay answers also await approval")
  await db.exec("set role authenticated")
  await db.query("select public.teacher_set_answer_score($1,$2,1.5)", [student, extraEssay])
  await db.exec("reset role")
  state = await scalar("select public.session_state_json($1)", [student])
  assert.equal(Number(state.result.score), 3.5, "approved fractional essay credit is included while other essays are pending")
  assert.equal(Number(state.result.max_score), 14)
  assert.equal(state.result.pending_questions, 1)
  assert.equal(state.review.find((q) => q.question_id === extraEssay).points_awarded, 1.5)
  await db.query("delete from public.questions where id=$1", [extraEssay])
  state = await scalar("select public.session_state_json($1)", [blankStudent])
  assert.equal(Number(state.result.score), 0, "blank submissions can display zero points so far")
  assert.equal(state.result.is_partial, true)
  await db.query("update public.exam_sessions set status='approved' where id=$1", [blankStudent])
  state = await scalar("select public.session_state_json($1)", [blankStudent])
  assert.equal(state.result, null, "unfinished attempts never receive scores or answer keys")
  assert.equal(state.review, null)
  await db.query("update public.exam_sessions set status='auto_submitted' where id=$1", [blankStudent])
  await db.exec("set role authenticated")
  const saveSql = "select public.teacher_save_essay_suggestion($1,$2,1,$3,$4,$5,'local:test')"
  const saveParams = [student, essay, "Encryption protects data.", snapshot, grading]
  const proposal = await scalar(saveSql, saveParams)
  assert.equal(await scalar("select score from public.exam_sessions where id=$1", [student]), null, "a suggestion never awards points")
  await reject("select public.teacher_approve_essay_suggestion($1,$2)", [proposal.id, { ...grading, criteria: [{ ...grading.criteria[0], points: 99 }, grading.criteria[1]] }], /INVALID_SCORE/)
  await reject("select public.teacher_approve_essay_suggestion($1,$2)", [proposal.id, { ...grading, criteria: [grading.criteria[0], grading.criteria[0]] }], /INVALID_GRADING/)
  await reject("select public.teacher_approve_essay_suggestion($1,$2)", [proposal.id, { ...grading, criteria: [{ ...grading.criteria[0], evidence: "fabricated evidence" }, grading.criteria[1]] }], /INVALID_EVIDENCE/)
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [other])
  assert.equal(Number(await scalar("select count(*) from public.essay_suggestions")), 0, "other teachers cannot read proposals")
  await reject("select public.teacher_approve_essay_suggestion($1,$2)", [proposal.id, grading], /FORBIDDEN/)
  await reject("select public.teacher_set_answer_score($1,$2,5)", [student, essay], /FORBIDDEN/)
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [teacher])
  await db.query("select public.teacher_approve_essay_suggestion($1,$2)", [proposal.id, grading])
  assert.equal(Number(await scalar("select score from public.exam_sessions where id=$1", [student])), 8)
  await db.query("select public.teacher_regrade_exam($1)", [exam])
  assert.equal(Number(await scalar("select score from public.exam_sessions where id=$1", [student])), 8, "regrading preserves teacher-approved points")
  await reject("select public.teacher_approve_essay_suggestion($1,$2)", [proposal.id, grading], /STALE_GRADING/)
  await db.exec("reset role")
  state = await scalar("select public.session_state_json($1)", [student])
  assert.equal(Number(state.result.score), 8)
  assert.equal(state.result.is_partial, false, "approving the last essay publishes a final score")
  assert.equal(state.review.find((q) => q.question_id === essay).rubric_scores.length, 2)
  assert.equal(state.review.find((q) => q.question_id === essay).rubric_feedback, grading.feedback)
  await db.exec("set role authenticated")
  await db.query("update public.exams set results_hidden=true where id=$1", [exam])
  await db.exec("reset role")
  state = await scalar("select public.session_state_json($1)", [student])
  assert.equal(state.result, null)
  assert.ok(state.review.every((r) => !("rubric_feedback" in r)), "hidden results do not leak teacher feedback")
  await db.exec("set role authenticated")
  const zero = { criteria: rubric.criteria.map((c) => ({ criterion_id: c.id, points: 0, reason: "No response", evidence: "" })), feedback: "" }
  await db.query("select public.teacher_approve_rubric_answer($1,$2,1,'',$3,$4)", [blankStudent, essay, snapshot, zero])
  assert.equal(Number(await scalar("select score from public.exam_sessions where id=$1", [blankStudent])), 0, "explicit zero approval completes grading")
  // Concept rules use the existing JSONB rubric and snapshot-checked manual approval.
  const rulesRubric = structuredClone(rubric)
  rulesRubric.criteria[0].checking_rule = { mode: "all", concepts: "Encryption | encrypting\nprotects data" }
  await db.query("update public.questions set rubric=$1 where id=$2", [rulesRubric, essay])
  assert.deepEqual(await scalar("select rubric from public.questions where id=$1", [essay]), rulesRubric, "concept rules persist without a migration")
  assert.equal(await scalar("select score from public.exam_sessions where id=$1", [student]), null, "rule changes invalidate approved scores")
  await db.query("update public.exams set results_hidden=false where id=$1", [exam])
  await db.exec("reset role")
  state = await scalar("select public.session_state_json($1)", [student])
  assert.equal(Number(state.result.score), 2, "stale approvals never contribute to the partial total")
  assert.equal(state.review.find((q) => q.question_id === essay).rubric_feedback, null)
  assert.equal(state.review.find((q) => q.question_id === essay).rubric_scores, null)
  await db.exec("set role authenticated")
  const ruleSnapshot = { ...snapshot, rubric: structuredClone(rulesRubric) }
  await db.query("select public.teacher_approve_rubric_answer($1,$2,1,$3,$4,$5)", [student, essay, "Encryption protects data.", ruleSnapshot, grading])
  assert.equal(Number(await scalar("select score from public.exam_sessions where id=$1", [student])), 8, "rule drafts use teacher approval to award points")
  rulesRubric.criteria[0].checking_rule.concepts = "confidentiality"
  await db.query("update public.questions set rubric=$1 where id=$2", [rulesRubric, essay])
  assert.equal(await scalar("select score from public.exam_sessions where id=$1", [student]), null, "editing only concepts invalidates approval")
  await reject("select public.teacher_approve_rubric_answer($1,$2,1,$3,$4,$5)", [student, essay, "Encryption protects data.", ruleSnapshot, grading], /STALE_GRADING/)
  await db.query("update public.questions set rubric=$1 where id=$2", [rubric, essay])
  const copyId = await scalar("select public.teacher_duplicate_exam($1)", [exam])
  assert.deepEqual(await scalar("select rubric from public.questions where exam_id=$1 and type='essay'", [copyId]), rubric)
  assert.equal(await scalar("select rubric_source_text from public.questions where exam_id=$1 and type='essay'", [copyId]), "Original rubric text")
  await db.query("update public.questions set prompt='Explain encryption with an example.' where id=$1", [essay])
  assert.equal(await scalar("select score from public.exam_sessions where id=$1", [student]), null)
  await reject("select public.teacher_approve_rubric_answer($1,$2,1,$3,$4,$5)", [student, essay, "Encryption protects data.", snapshot, grading], /STALE_GRADING/)
  await reject("select public.teacher_set_answer_score($1,$2,'NaN')", [student, essay], /INVALID_SCORE/)
  await reject("select public.teacher_set_answer_score($1,$2,5)", [student, (await scalar("select id from public.questions where exam_id=$1 limit 1", [copyId]))], /INVALID_QUESTION/)
  await db.query("update public.exams set status='open' where id=$1", [exam])
  await db.query("select public.teacher_allow_retake($1)", [student])
  assert.equal(Number(await scalar("select count(*) from public.essay_suggestions where session_id=$1", [student])), 0, "retakes remove prior attempt proposals")
  await reject("select public.teacher_set_answer_score($1,$2,5)", [student, essay], /NOT_FINISHED/)
  await db.exec("reset role")
  const token = await scalar("insert into public.session_tokens(session_id) values($1) returning token", [student])
  await db.exec("set role anon")
  await db.query("select public.student_start($1)", [token])
  await db.query("select public.student_save_answer($1,$2,$3)", [token, essay, "E".repeat(4500)])
  await reject("select public.student_save_answer($1,$2,$3)", [token, essay, "E".repeat(5001)], /ANSWER_TOO_LONG/)
  await reject("select * from public.essay_suggestions", [], /permission denied/)
  await reject("select public.teacher_approve_rubric_answer($1,$2,1,'',$3,$4)", [blankStudent, essay, snapshot, zero], /permission denied/)
  await db.exec("reset role")
  assert.equal(Number(await scalar("select char_length(answer) from public.answers where session_id=$1 and question_id=$2", [student, essay])), 4500, "long essays are not truncated")
  await db.query("update public.exams set scheduled_start_at=now()-interval '2 hours',scheduled_end_at=now()-interval '1 hour' where id=$1", [exam])
  await db.exec("set role anon")
  await db.query("select public.student_save_answer($1,$2,'Late edit')", [token, essay])
  await db.exec("reset role")
  assert.equal(await scalar("select status from public.exam_sessions where id=$1", [student]), "auto_submitted")
  assert.equal(Number(await scalar("select char_length(answer) from public.answers where session_id=$1 and question_id=$2", [student, essay])), 4500, "late saves cannot change submitted essays")

  // TypeScript helper checks cover JSONB key order and invalid model output.
  const source = ts.transpileModule(readFileSync("src/lib/rubric.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.ES2022 } }).outputText
  const helpers = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)
  assert.deepEqual(helpers.validateRubric(rubric, 10), rubric)
  assert.throws(() => helpers.validateRubric(rubric, 9))
  assert.throws(() => helpers.validateGrading({ ...grading, criteria: [{ ...grading.criteria[0], points: NaN }, grading.criteria[1]] }, rubric))
  assert.throws(() => helpers.validateGrading({ ...grading, criteria: [grading.criteria[0], grading.criteria[0]] }, rubric))
  const reordered = { criteria: rubric.criteria.map((c) => ({ description: c.description, max_points: c.max_points, name: c.name, id: c.id })) }
  assert.equal(helpers.rubricsEqual(rubric, reordered), true)
  assert.equal(helpers.essayApproved({ type: "essay", ...snapshot }, { overridden: true, approval_snapshot: { ...snapshot, rubric: reordered } }), true)
  // The standalone SQL setup must also work without prior partial-credit migrations.
  await db.exec("drop schema public cascade; create schema public")
  await db.exec(readFileSync("supabase/schema.sql", "utf8"))
  assert.ok(await scalar("select to_regprocedure('public.teacher_approve_rubric_answer(uuid,uuid,integer,text,jsonb,jsonb)') is not null"))
  console.log("PASS: upgrade, pending results, manual/AI approval, partial/zero scores, regrading, stale inputs, rubric feedback, duplication, retakes and access controls.")
} catch (error) {
  console.error("FAIL:", error.message, error.where ?? "")
  process.exitCode = 1
} finally { await db.close() }
