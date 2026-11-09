-- =====================================================================
-- Update 03 — "Deduct points" (teacher takes points off, e.g. for cheating)
--
-- Only for databases that already ran an older schema.sql (+ update-01, -02).
-- (A fresh setup just runs schema.sql, which already includes this.)
-- Supabase Dashboard → SQL Editor → New query → paste → Run. Safe to run twice.
-- =====================================================================

-- Points the teacher took off; subtracted from the graded score
alter table public.exam_sessions add column if not exists deduction numeric not null default 0;
alter table public.exam_sessions drop constraint if exists exam_sessions_deduction_check;
alter table public.exam_sessions add constraint exam_sessions_deduction_check check (deduction >= 0);

-- Points taken off, on 'points_deducted' activity-log entries
alter table public.session_events add column if not exists points numeric;

-- New activity-log entry type
alter table public.session_events drop constraint if exists session_events_type_check;
alter table public.session_events add constraint session_events_type_check check (type in (
  'join_requested', 'approved', 'rejected', 'started',
  'left', 'returned', 'idle', 'idle_ended',
  'blocked_action', 'fullscreen_exit',
  'submitted', 'auto_submitted',
  'retake_allowed', 'points_deducted'
));

-- Grading now subtracts the deduction (never below 0)
create or replace function public.grade_session(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_exam_id uuid;
begin
  select exam_id into v_exam_id from public.exam_sessions where id = p_session_id;

  -- Grade every non-overridden answer against the key.
  update public.answers a
  set is_correct = case
        when q.type = 'identification' then exists (
          select 1 from unnest(q.correct_answers) k
          where public.normalize_answer(k) = public.normalize_answer(a.answer)
            and public.normalize_answer(a.answer) <> ''
        )
        else a.answer = any (q.correct_answers)
      end,
      points_awarded = case
        when (
          case
            when q.type = 'identification' then exists (
              select 1 from unnest(q.correct_answers) k
              where public.normalize_answer(k) = public.normalize_answer(a.answer)
                and public.normalize_answer(a.answer) <> ''
            )
            else a.answer = any (q.correct_answers)
          end
        ) then q.points else 0
      end
  from public.questions q
  where a.session_id = p_session_id
    and q.id = a.question_id
    and not a.overridden;

  -- Overridden answers keep their verdict but follow the question's current points.
  update public.answers a
  set points_awarded = case when a.is_correct then q.points else 0 end
  from public.questions q
  where a.session_id = p_session_id and q.id = a.question_id and a.overridden;

  update public.exam_sessions s
  set score = greatest(0, coalesce((
        select sum(a.points_awarded) from public.answers a where a.session_id = p_session_id
      ), 0) - s.deduction),
      max_score = coalesce((
        select sum(q.points) from public.questions q where q.exam_id = v_exam_id
      ), 0)
  where s.id = p_session_id;
end;
$$;

-- A retake also clears the deduction
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
      deduction = 0,
      result_code = null
  where id = s.id;

  insert into public.session_events (session_id, exam_id, type, detail)
  values (s.id, s.exam_id, 'retake_allowed', (s.attempt + 1)::text);
end;
$$;

-- Takes points off a student's score (e.g. the teacher caught them cheating).
-- Works during or after the exam; the deduction is applied whenever the
-- session is graded and is logged in the activity feed with the reason.
create or replace function public.teacher_deduct_points(p_session_id uuid, p_points numeric, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.exam_sessions;
  v_reason text := nullif(left(btrim(coalesce(p_reason, '')), 200), '');
begin
  if not public.owns_session(p_session_id) then
    raise exception 'FORBIDDEN';
  end if;
  if p_points is null or p_points <= 0 or p_points > 10000 then
    raise exception 'INVALID_POINTS' using hint = 'Enter a positive number of points to deduct.';
  end if;
  select * into s from public.exam_sessions where id = p_session_id for update;
  if s.status in ('pending', 'rejected') then
    raise exception 'NOT_TAKING_EXAM' using hint = 'Only approved students can have points deducted.';
  end if;

  update public.exam_sessions set deduction = deduction + p_points where id = s.id;

  insert into public.session_events (session_id, exam_id, type, points, detail)
  values (s.id, s.exam_id, 'points_deducted', p_points, v_reason);

  if s.status in ('submitted', 'auto_submitted') then
    perform public.grade_session(s.id);
  end if;
end;
$$;

revoke execute on function public.teacher_deduct_points(uuid, numeric, text) from public, anon;
grant execute on function public.teacher_deduct_points(uuid, numeric, text) to authenticated;
