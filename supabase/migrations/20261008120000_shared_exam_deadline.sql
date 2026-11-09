alter table public.exams
  add column scheduled_start_at timestamptz,
  add column scheduled_end_at timestamptz,
  add constraint exams_schedule_pair check ((scheduled_start_at is null) = (scheduled_end_at is null)),
  add constraint exams_schedule_order check (scheduled_end_at is null or scheduled_end_at > scheduled_start_at);

alter table public.session_events drop constraint session_events_type_check;
alter table public.session_events add constraint session_events_type_check check (type in (
  'join_requested', 'approved', 'rejected', 'started',
  'left', 'returned', 'idle', 'idle_ended',
  'blocked_action', 'screenshot_attempt', 'fullscreen_exit',
  'submitted', 'auto_submitted',
  'retake_allowed', 'points_deducted', 'deduction_undone'
));

-- Finish overdue attempts on the next student request. Student pages heartbeat
-- every four seconds while active, so this also handles closed/background tabs.
create or replace function public.finish_session_if_deadline(p_session_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.exam_sessions;
  e public.exams;
begin
  select * into s from public.exam_sessions where id = p_session_id for update;
  if s.id is null or s.status <> 'in_progress' then return false; end if;
  select * into e from public.exams where id = s.exam_id;
  if e.scheduled_end_at is not null and e.scheduled_end_at <= now() then
    perform public.finish_session(s.id, true, 'time_limit');
    return true;
  end if;
  return false;
end;
$$;
revoke all on function public.finish_session_if_deadline(uuid) from public, anon, authenticated;

create or replace function public.session_state_json(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.exam_sessions;
  e public.exams;
  v_finished boolean;
  v_results_visible boolean;
  v_review jsonb := null;
  v_auto_reason text;
begin
  select * into s from public.exam_sessions where id = p_session_id;
  select * into e from public.exams where id = s.exam_id;
  v_finished := s.status in ('submitted', 'auto_submitted');
  v_results_visible := v_finished and (e.show_score = 'immediately' or e.results_released);
  if s.status = 'auto_submitted' then
    select detail into v_auto_reason from public.session_events
    where session_id = s.id and type = 'auto_submitted' order by created_at desc limit 1;
  end if;

  if v_results_visible and e.show_correct_answers then
    select coalesce(jsonb_agg(jsonb_build_object(
      'question_id', q.id, 'prompt', q.prompt, 'type', q.type, 'choices', q.choices,
      'points', q.points, 'points_awarded', a.points_awarded, 'your_answer', a.answer,
      'is_correct', coalesce(a.is_correct, false), 'correct_answers', to_jsonb(q.correct_answers)
    ) order by q.position, q.created_at), '[]'::jsonb)
    into v_review
    from public.questions q left join public.answers a on a.question_id = q.id and a.session_id = s.id
    where q.exam_id = e.id;
  end if;

  return jsonb_build_object(
    'session', jsonb_build_object(
      'student_name', s.student_name, 'student_email', s.student_email, 'status', s.status,
      'activity', s.activity, 'violation_count', s.violation_count, 'started_at', s.started_at,
      'submitted_at', s.submitted_at, 'result_code', case when v_finished then s.result_code end,
      'auto_submit_reason', v_auto_reason
    ),
    'exam', jsonb_build_object(
      'code', e.code, 'title', e.title, 'instructions', e.instructions, 'status', e.status,
      'max_violations', e.max_violations, 'warn_at', e.warn_at,
      'idle_limit_seconds', e.idle_limit_seconds, 'idle_counts_as_violation', e.idle_counts_as_violation,
      'block_copy_paste', e.block_copy_paste,
      'question_count', (select count(*) from public.questions q where q.exam_id = e.id),
      'scheduled_start_at', e.scheduled_start_at, 'scheduled_end_at', e.scheduled_end_at,
      'server_now', clock_timestamp()
    ),
    'result', case when v_results_visible then jsonb_build_object('score', s.score, 'max_score', s.max_score, 'review', v_review) else null end
  );
end;
$$;

create or replace function public.student_join(p_code text, p_email text, p_name text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  e public.exams;
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_name text := btrim(coalesce(p_name, ''));
  v_session_id uuid;
  v_token uuid;
begin
  select * into e from public.exams where code = upper(btrim(coalesce(p_code, '')));
  if e.id is null then raise exception 'EXAM_NOT_FOUND' using hint = 'Check the exam code with your teacher.'; end if;
  if e.status = 'closed' or (e.scheduled_end_at is null and e.status <> 'open') or
     (e.scheduled_end_at is not null and e.scheduled_end_at <= now()) then
    raise exception 'EXAM_NOT_OPEN' using hint = 'This exam is not accepting students right now.';
  end if;
  if v_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'INVALID_EMAIL' using hint = 'Enter a valid email address.'; end if;
  if char_length(v_name) not between 1 and 120 then raise exception 'INVALID_NAME' using hint = 'Enter your full name.'; end if;
  if exists (select 1 from public.exam_sessions where exam_id = e.id and student_email = v_email) then
    raise exception 'ALREADY_JOINED' using hint = 'This email already joined. Continue on the device you used, or ask your teacher to remove your entry.';
  end if;
  insert into public.exam_sessions (exam_id, student_email, student_name) values (e.id, v_email, v_name) returning id into v_session_id;
  insert into public.session_tokens (session_id) values (v_session_id) returning token into v_token;
  insert into public.session_events (session_id, exam_id, type) values (v_session_id, e.id, 'join_requested');
  return jsonb_build_object('token', v_token, 'code', e.code);
end;
$$;

create or replace function public.student_state(p_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session_id uuid := public.session_for_token(p_token);
begin
  if v_session_id is null then raise exception 'INVALID_TOKEN'; end if;
  perform public.finish_session_if_deadline(v_session_id);
  update public.exam_sessions set last_seen_at = now()
  where id = v_session_id and last_seen_at < now() - interval '10 seconds';
  return public.session_state_json(v_session_id);
end;
$$;

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
  if s.id is null then raise exception 'INVALID_TOKEN'; end if;
  perform public.finish_session_if_deadline(s.id);
  select * into s from public.exam_sessions where id = v_session_id;
  if s.status in ('submitted', 'auto_submitted') then return '[]'::jsonb; end if;
  if s.status <> 'in_progress' then raise exception 'NOT_IN_PROGRESS'; end if;
  select * into e from public.exams where id = s.exam_id;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', q.id, 'type', q.type, 'prompt', q.prompt, 'choices', q.choices,
      'choice_order', coalesce((select jsonb_agg(i order by case when e.shuffle_choices then md5(s.id::text || q.id::text || i::text) end, i) from generate_series(0, jsonb_array_length(q.choices) - 1) i), '[]'::jsonb),
      'points', q.points, 'answer', a.answer
    ) order by case when e.shuffle_questions then md5(s.id::text || q.id::text) end, q.position, q.created_at)
    from public.questions q left join public.answers a on a.question_id = q.id and a.session_id = s.id
    where q.exam_id = s.exam_id
  ), '[]'::jsonb);
end;
$$;

create or replace function public.student_start(p_token uuid)
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
  select * into s from public.exam_sessions where id = v_session_id for update;
  if s.id is null then raise exception 'INVALID_TOKEN'; end if;
  select * into e from public.exams where id = s.exam_id;
  if e.status = 'closed' or (e.scheduled_end_at is null and e.status <> 'open') or
     (e.scheduled_end_at is not null and (e.scheduled_start_at > now() or e.scheduled_end_at <= now())) then
    raise exception 'EXAM_NOT_OPEN' using hint = 'The scheduled exam window is not open right now.';
  end if;
  if s.status = 'approved' then
    update public.exam_sessions set status = 'in_progress', started_at = now(), activity = 'active', activity_since = now(), last_seen_at = now() where id = s.id;
    insert into public.session_events (session_id, exam_id, type) values (s.id, s.exam_id, 'started');
  elsif s.status <> 'in_progress' then raise exception 'NOT_APPROVED'; end if;
  return public.student_state(p_token);
end;
$$;

create or replace function public.student_save_answer(p_token uuid, p_question_id uuid, p_answer text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session_id uuid := public.session_for_token(p_token);
  s public.exam_sessions;
begin
  if v_session_id is null then raise exception 'INVALID_TOKEN'; end if;
  perform public.finish_session_if_deadline(v_session_id);
  select * into s from public.exam_sessions where id = v_session_id;
  if s.status <> 'in_progress' then raise exception 'NOT_IN_PROGRESS'; end if;
  if not exists (select 1 from public.questions where id = p_question_id and exam_id = s.exam_id) then raise exception 'INVALID_QUESTION'; end if;
  insert into public.answers (session_id, question_id, answer, updated_at)
  values (s.id, p_question_id, left(coalesce(p_answer, ''), 2000), now())
  on conflict (session_id, question_id) do update set answer = excluded.answer, updated_at = now();
end;
$$;

create or replace function public.student_report(p_token uuid, p_type text, p_detail text default null, p_duration int default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session_id uuid := public.session_for_token(p_token);
  s public.exam_sessions;
  e public.exams;
  v_count int;
  v_counted boolean := false;
  v_duration int := least(greatest(coalesce(p_duration, 0), 0), 86400);
  v_detail text := left(p_detail, 40);
begin
  if v_session_id is null then raise exception 'INVALID_TOKEN'; end if;
  perform public.finish_session_if_deadline(v_session_id);
  select * into s from public.exam_sessions where id = v_session_id for update;
  select * into e from public.exams where id = s.exam_id;
  if s.status <> 'in_progress' then return public.student_state(p_token); end if;
  update public.exam_sessions set last_seen_at = now() where id = s.id;

  if p_type = 'screenshot_attempt' then
    if not exists (select 1 from public.session_events where session_id = s.id and type = 'screenshot_attempt' and created_at > now() - interval '2 seconds') then
      update public.exam_sessions set violation_count = violation_count + 1 where id = s.id returning violation_count into v_count;
      insert into public.session_events (session_id, exam_id, type, counted, violation_number)
      values (s.id, s.exam_id, 'screenshot_attempt', true, v_count);
      v_counted := true;
    end if;
  elsif p_type = 'left' then
    if s.activity <> 'away' then
      update public.exam_sessions set activity = 'away', activity_since = now(), violation_count = violation_count + 1 where id = s.id returning violation_count into v_count;
      insert into public.session_events (session_id, exam_id, type, counted, violation_number) values (s.id, s.exam_id, 'left', true, v_count);
      v_counted := true;
    end if;
  elsif p_type = 'returned' then
    if s.activity = 'away' then
      update public.exam_sessions set activity = 'active', activity_since = now() where id = s.id;
      insert into public.session_events (session_id, exam_id, type, duration_seconds) values (s.id, s.exam_id, 'returned', greatest(v_duration, extract(epoch from now() - s.activity_since)::int));
    end if;
  elsif p_type = 'idle' then
    if s.activity = 'active' then
      v_counted := e.idle_counts_as_violation;
      update public.exam_sessions set activity = 'idle', activity_since = now(), violation_count = violation_count + case when v_counted then 1 else 0 end where id = s.id returning violation_count into v_count;
      insert into public.session_events (session_id, exam_id, type, counted, violation_number) values (s.id, s.exam_id, 'idle', v_counted, case when v_counted then v_count end);
    end if;
  elsif p_type = 'idle_ended' then
    if s.activity = 'idle' then
      update public.exam_sessions set activity = 'active', activity_since = now() where id = s.id;
      insert into public.session_events (session_id, exam_id, type, duration_seconds) values (s.id, s.exam_id, 'idle_ended', greatest(v_duration, extract(epoch from now() - s.activity_since)::int));
    end if;
  elsif p_type in ('blocked_action', 'fullscreen_exit') then
    if not exists (select 1 from public.session_events where session_id = s.id and type = p_type and detail is not distinct from v_detail and created_at > now() - interval '3 seconds') then
      insert into public.session_events (session_id, exam_id, type, detail) values (s.id, s.exam_id, p_type, v_detail);
    end if;
  else raise exception 'INVALID_EVENT'; end if;

  if v_counted and v_count >= e.max_violations then perform public.finish_session(s.id, true, 'max_violations'); end if;
  return public.student_state(p_token);
end;
$$;

create or replace function public.student_submit(p_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session_id uuid := public.session_for_token(p_token);
  e public.exams;
begin
  if v_session_id is null then raise exception 'INVALID_TOKEN'; end if;
  perform public.finish_session_if_deadline(v_session_id);
  select x.* into e from public.exam_sessions s join public.exams x on x.id = s.exam_id where s.id = v_session_id;
  if e.scheduled_end_at is not null and e.scheduled_end_at <= now() then
    perform public.finish_session(v_session_id, true, 'time_limit');
  else
    perform public.finish_session(v_session_id, false, null);
  end if;
  return public.student_state(p_token);
end;
$$;
