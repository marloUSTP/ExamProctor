-- =====================================================================
-- Update 02 — "Allow retake" and "Duplicate exam"
--
-- Only for databases that already ran an older schema.sql (+ update-01).
-- (A fresh setup just runs schema.sql, which already includes this.)
-- Supabase Dashboard → SQL Editor → New query → paste → Run. Safe to run twice.
-- =====================================================================

-- Which attempt the student is on (2, 3, … after the teacher allows a retake)
alter table public.exam_sessions add column if not exists attempt int not null default 1;

-- New activity-log entry type
alter table public.session_events drop constraint if exists session_events_type_check;
alter table public.session_events add constraint session_events_type_check check (type in (
  'join_requested', 'approved', 'rejected', 'started',
  'left', 'returned', 'idle', 'idle_ended',
  'blocked_action', 'fullscreen_exit',
  'submitted', 'auto_submitted',
  'retake_allowed'
));

-- Lets a student who finished take the exam again: answers, score, violations
-- and result code are cleared; the activity log keeps the earlier attempt.
-- Their exam page returns to "Start exam" on its own.
create or replace function public.teacher_allow_retake(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.exam_sessions;
begin
  if not public.owns_session(p_session_id) then
    raise exception 'FORBIDDEN';
  end if;
  select * into s from public.exam_sessions where id = p_session_id for update;
  if s.status not in ('submitted', 'auto_submitted') then
    raise exception 'NOT_FINISHED' using hint = 'Only students who have finished the exam can retake it.';
  end if;
  if not exists (select 1 from public.exams where id = s.exam_id and status = 'open') then
    raise exception 'EXAM_NOT_OPEN' using hint = 'Reopen the exam first so the student can start again.';
  end if;

  delete from public.answers where session_id = s.id;
  update public.exam_sessions
  set status = 'approved',
      attempt = attempt + 1,
      activity = 'active',
      activity_since = now(),
      violation_count = 0,
      started_at = null,
      submitted_at = null,
      score = null,
      max_score = null,
      result_code = null
  where id = s.id;

  insert into public.session_events (session_id, exam_id, type, detail)
  values (s.id, s.exam_id, 'retake_allowed', (s.attempt + 1)::text);
end;
$$;

-- Copies an exam — settings, questions and answer key — as a new draft with a new code.
-- Students, answers and results are not copied.
create or replace function public.teacher_duplicate_exam(p_exam_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new_id uuid;
begin
  if not public.owns_exam(p_exam_id) then
    raise exception 'FORBIDDEN';
  end if;

  insert into public.exams (
    teacher_id, title, instructions,
    max_violations, warn_at, idle_limit_seconds, idle_counts_as_violation, block_copy_paste,
    shuffle_questions, shuffle_choices, show_score, show_correct_answers
  )
  select teacher_id, left(title || ' (copy)', 200), instructions,
         max_violations, warn_at, idle_limit_seconds, idle_counts_as_violation, block_copy_paste,
         shuffle_questions, shuffle_choices, show_score, show_correct_answers
  from public.exams
  where id = p_exam_id
  returning id into v_new_id;

  insert into public.questions (exam_id, position, type, prompt, choices, correct_answers, points)
  select v_new_id, position, type, prompt, choices, correct_answers, points
  from public.questions
  where exam_id = p_exam_id;

  return v_new_id;
end;
$$;

revoke execute on function public.teacher_allow_retake(uuid) from public, anon;
revoke execute on function public.teacher_duplicate_exam(uuid) from public, anon;
grant execute on function public.teacher_allow_retake(uuid) to authenticated;
grant execute on function public.teacher_duplicate_exam(uuid) to authenticated;
