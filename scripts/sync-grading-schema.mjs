// Keep the standalone SQL setup aligned with the additive grading migration.
import { readFileSync, writeFileSync } from "node:fs"

const migrationPath = "supabase/migrations/20261014090000_rubric_essay_grading.sql"
const marker = "-- BEGIN RUBRIC GRADING SETUP"
let migration = readFileSync(migrationPath, "utf8").split("-- Student-facing grading visibility")[0].trimEnd()
const previousState = readFileSync("supabase/migrations/20261008150000_release_student_answer_review.sql", "utf8")
let state = previousState.slice(previousState.indexOf("create or replace function public.session_state_json"))
state = state.replace("v_finished and not e.results_hidden", "v_finished and not public.session_needs_grading(s.id) and s.score is not null and not e.results_hidden")
state = state.replace("'auto_submit_reason', v_auto_reason", "'auto_submit_reason', v_auto_reason,\n      'grading_pending', v_finished and public.session_needs_grading(s.id)")
state = state.replace("'points_awarded', coalesce(a.points_awarded, 0)", `'points_awarded', coalesce(a.points_awarded, 0),
      'rubric_feedback', a.rubric_grading->>'feedback',
      'rubric_scores', case when a.rubric_grading is not null then (
        select jsonb_agg(jsonb_build_object(
          'name', r.value->>'name', 'max_points', r.value->'max_points',
          'points', g.value->'points', 'reason', g.value->>'reason'
        ) order by r.ordinality)
        from jsonb_array_elements(q.rubric->'criteria') with ordinality r(value, ordinality)
        join jsonb_array_elements(a.rubric_grading->'criteria') g(value) on g.value->>'criterion_id' = r.value->>'id'
      ) else null end`)
const schema = readFileSync("supabase/schema.sql", "utf8").split(marker)[0].trimEnd()
const duplicate = schema.match(/create or replace function public\.teacher_duplicate_exam\(p_exam_id uuid\)[\s\S]*?\$\$;/)?.[0]
if (!duplicate) throw new Error("Could not find the exam duplication function")
const updatedDuplicate = duplicate
  .replace("(exam_id, position, type, prompt, choices, correct_answers, points)", "(exam_id, position, type, prompt, choices, correct_answers, points, rubric, rubric_source_text)")
  .replace("select v_new_id, position, type, prompt, choices, correct_answers, points", "select v_new_id, position, type, prompt, choices, correct_answers, points, rubric, rubric_source_text")
migration += `\n\n-- Student-facing grading visibility\n${state.trim()}\n\n-- Duplicated exams retain their rubrics and source text.\n${updatedDuplicate}\n`
writeFileSync(migrationPath, migration)
const registration = readFileSync("supabase/migrations/20261015110000_student_name_registration.sql", "utf8")
const emailContinue = readFileSync("supabase/migrations/20261015120000_email_only_exam_continue.sql", "utf8")
const uppercaseNames = readFileSync("supabase/migrations/20261015130000_uppercase_student_names.sql", "utf8")
const geminiRequests = readFileSync("supabase/migrations/20261018100000_gemini_teacher_requests.sql", "utf8")
const partialScores = readFileSync("supabase/migrations/20261029090000_release_partial_student_scores.sql", "utf8")
writeFileSync("supabase/schema.sql", `${schema}\n\n${marker}\n${migration}\n-- END RUBRIC GRADING SETUP\n\n-- BEGIN STUDENT NAME REGISTRATION\n${registration}\n-- END STUDENT NAME REGISTRATION\n\n${emailContinue}\n${uppercaseNames}\n${geminiRequests}\n${partialScores}\n`)
