-- =====================================================================
-- Update 01 — result codes, "Check my score", shuffled questions/choices
--
-- Only for databases that already ran the FIRST version of schema.sql.
-- (A fresh setup just runs schema.sql, which already includes this.)
-- Supabase Dashboard → SQL Editor → New query → paste → Run. Safe to run twice.
-- =====================================================================

-- New per-exam settings (on by default)
alter table public.exams add column if not exists shuffle_questions boolean not null default true;
alter table public.exams add column if not exists shuffle_choices boolean not null default true;

-- Personal code a student uses to look up their score later from any device
alter table public.exam_sessions add column if not exists result_code text;

create or replace function public.generate_result_code()
returns text
language sql
volatile
set search_path = ''
as $$
  select 'R-' || public.generate_exam_code();
$$;

-- Ends a session (student submit, auto-submit, or teacher/closing the exam).
create or replace function public.finish_session(p_session_id uuid, p_auto boolean, p_detail text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_exam_id uuid;
begin
  update public.exam_sessions
  set status = case when p_auto then 'auto_submitted' else 'submitted' end,
      submitted_at = now(),
      activity = 'active',
      activity_since = now(),
      result_code = coalesce(result_code, public.generate_result_code())
  where id = p_session_id and status = 'in_progress'
  returning exam_id into v_exam_id;

  if v_exam_id is null then
    return; -- already finished
  end if;

  insert into public.session_events (session_id, exam_id, type, detail)
  values (p_session_id, v_exam_id, case when p_auto then 'auto_submitted' else 'submitted' end, p_detail);

  perform public.grade_session(p_session_id);
end;
$$;

-- Everything the student's page shows, for one session (no heartbeat, no auth check).
create or replace function public.session_state_json(p_session_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s public.exam_sessions;
  e public.exams;
  v_finished boolean;
  v_results_visible boolean;
  v_review jsonb := null;
begin
  select * into s from public.exam_sessions where id = p_session_id;
  select * into e from public.exams where id = s.exam_id;

  v_finished := s.status in ('submitted', 'auto_submitted');
  v_results_visible := v_finished and (e.show_score = 'immediately' or e.results_released);

  if v_results_visible and e.show_correct_answers then
    select coalesce(jsonb_agg(jsonb_build_object(
             'question_id', q.id,
             'prompt', q.prompt,
             'type', q.type,
             'choices', q.choices,
             'points', q.points,
             'your_answer', a.answer,
             'is_correct', coalesce(a.is_correct, false),
             'correct_answers', to_jsonb(q.correct_answers)
           ) order by q.position, q.created_at), '[]'::jsonb)
    into v_review
    from public.questions q
    left join public.answers a on a.question_id = q.id and a.session_id = s.id
    where q.exam_id = e.id;
  end if;

  return jsonb_build_object(
    'session', jsonb_build_object(
      'student_name', s.student_name,
      'student_email', s.student_email,
      'status', s.status,
      'activity', s.activity,
      'violation_count', s.violation_count,
      'started_at', s.started_at,
      'submitted_at', s.submitted_at,
      'result_code', case when v_finished then s.result_code end
    ),
    'exam', jsonb_build_object(
      'code', e.code,
      'title', e.title,
      'instructions', e.instructions,
      'status', e.status,
      'max_violations', e.max_violations,
      'warn_at', e.warn_at,
      'idle_limit_seconds', e.idle_limit_seconds,
      'idle_counts_as_violation', e.idle_counts_as_violation,
      'block_copy_paste', e.block_copy_paste,
      'question_count', (select count(*) from public.questions q where q.exam_id = e.id)
    ),
    'result', case when v_results_visible then jsonb_build_object(
      'score', s.score,
      'max_score', s.max_score,
      'review', v_review
    ) else null end
  );
end;
$$;

-- Polled by the student page every few seconds; doubles as the heartbeat.
create or replace function public.student_state(p_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session_id uuid := public.session_for_token(p_token);
begin
  if v_session_id is null then
    raise exception 'INVALID_TOKEN';
  end if;

  -- Heartbeat: only write every 10s so the teacher's realtime feed isn't flooded.
  update public.exam_sessions
  set last_seen_at = now()
  where id = v_session_id and last_seen_at < now() - interval '10 seconds';

  return public.session_state_json(v_session_id);
end;
$$;

-- Questions WITHOUT the answer key, plus the student's saved answers.
-- Each student gets their own stable order (same order again after a refresh).
-- choice_order lists the original choice indexes in display order; answers are
-- still stored as the original index, so grading is unaffected by shuffling.
create or replace function public.student_questions(p_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session_id uuid := public.session_for_token(p_token);
  s public.exam_sessions;
  e public.exams;
begin
  select * into s from public.exam_sessions where id = v_session_id;
  if s.id is null then
    raise exception 'INVALID_TOKEN';
  end if;
  if s.status <> 'in_progress' then
    raise exception 'NOT_IN_PROGRESS';
  end if;
  select * into e from public.exams where id = s.exam_id;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', q.id,
             'type', q.type,
             'prompt', q.prompt,
             'choices', q.choices,
             'choice_order', coalesce((
               select jsonb_agg(i order by
                 case when e.shuffle_choices then md5(s.id::text || q.id::text || i::text) end, i)
               from generate_series(0, jsonb_array_length(q.choices) - 1) i
             ), '[]'::jsonb),
             'points', q.points,
             'answer', a.answer
           ) order by
             case when e.shuffle_questions then md5(s.id::text || q.id::text) end,
             q.position, q.created_at)
    from public.questions q
    left join public.answers a on a.question_id = q.id and a.session_id = s.id
    where q.exam_id = s.exam_id
  ), '[]'::jsonb);
end;
$$;

-- "Check my score": exam code + email + personal result code, from any device.
create or replace function public.student_lookup_result(p_code text, p_email text, p_result_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text := upper(regexp_replace(coalesce(p_result_code, ''), '[^A-Za-z0-9]', '', 'g'));
  v_session_id uuid;
begin
  -- Accept "R-4F9K2P", "r4f9k2p" or just "4F9K2P".
  if v_code !~ '^R' or length(v_code) = 6 then
    v_code := 'R' || v_code;
  end if;

  select s.id into v_session_id
  from public.exam_sessions s
  join public.exams e on e.id = s.exam_id
  where e.code = upper(btrim(coalesce(p_code, '')))
    and s.student_email = lower(btrim(coalesce(p_email, '')))
    and replace(s.result_code, '-', '') = v_code
    and s.status in ('submitted', 'auto_submitted');

  if v_session_id is null then
    -- Same message for every mismatch so codes can't be probed one field at a time.
    raise exception 'RESULT_NOT_FOUND'
      using hint = 'No result matches that exam code, email and result code. Check them and try again.';
  end if;

  return public.session_state_json(v_session_id);
end;
$$;

-- Give result codes to students who submitted before this update.
update public.exam_sessions
set result_code = public.generate_result_code()
where result_code is null and status in ('submitted', 'auto_submitted');

-- Permissions for the new functions (internal helpers stay private).
revoke execute on function public.generate_result_code() from public, anon, authenticated;
revoke execute on function public.session_state_json(uuid) from public, anon, authenticated;
revoke execute on function public.student_lookup_result(text, text, text) from public;
grant execute on function public.student_lookup_result(text, text, text) to anon, authenticated;
