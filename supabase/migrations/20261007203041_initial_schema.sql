-- =====================================================================
-- Exam Proctor — Supabase schema
-- Run this whole file once in Supabase Dashboard → SQL Editor → New query.
--
-- Security model
--   * Teachers sign in with Supabase Auth and reach their data through
--     Row Level Security (they only ever see exams they own).
--   * Students have no account. When they join they receive a secret
--     session token; every student action goes through a SECURITY DEFINER
--     function below that checks that token. Students can't read any table
--     directly, so the answer key never leaves the database.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------

-- 6-character join code without look-alike characters (0/O, 1/I/L).
create or replace function public.generate_exam_code()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  result text := '';
begin
  for i in 1..6 loop
    result := result || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
  end loop;
  return result;
end;
$$;

create or replace function public.generate_result_code()
returns text
language sql
volatile
set search_path = ''
as $$
  select 'R-' || public.generate_exam_code();
$$;

-- Normalises identification answers: case, surrounding and repeated spaces.
create or replace function public.normalize_answer(value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select lower(regexp_replace(btrim(coalesce(value, '')), '\s+', ' ', 'g'));
$$;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

create table public.exams (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 200),
  instructions text not null default '',
  code text not null unique default public.generate_exam_code(),
  status text not null default 'draft' check (status in ('draft', 'open', 'closed')),

  -- Proctoring settings
  max_violations int not null default 5 check (max_violations between 1 and 50),
  warn_at int not null default 4 check (warn_at >= 1),
  idle_limit_seconds int not null default 120 check (idle_limit_seconds between 30 and 3600),
  idle_counts_as_violation boolean not null default false,
  block_copy_paste boolean not null default true,
  shuffle_questions boolean not null default true,
  shuffle_choices boolean not null default true,

  -- Result settings
  show_score text not null default 'immediately' check (show_score in ('immediately', 'after_release')),
  results_released boolean not null default false,
  show_correct_answers boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint warn_before_max check (warn_at <= max_violations)
);

create table public.questions (
  id uuid primary key default gen_random_uuid(),
  exam_id uuid not null references public.exams (id) on delete cascade,
  position int not null default 0,
  type text not null check (type in ('multiple_choice', 'true_false', 'identification')),
  prompt text not null check (char_length(prompt) between 1 and 5000),
  -- multiple_choice: array of choice labels, e.g. ["Manila","Cebu","Davao"]
  choices jsonb not null default '[]'::jsonb check (jsonb_typeof(choices) = 'array'),
  -- The answer key.
  --   multiple_choice → index of the correct choice, e.g. {"1"}
  --   true_false      → {"true"} or {"false"}
  --   identification  → every accepted answer, e.g. {"Jose Rizal","Rizal"}
  correct_answers text[] not null default '{}',
  points int not null default 1 check (points between 0 and 100),
  created_at timestamptz not null default now()
);
create index questions_exam_idx on public.questions (exam_id, position);

create table public.exam_sessions (
  id uuid primary key default gen_random_uuid(),
  exam_id uuid not null references public.exams (id) on delete cascade,
  student_email text not null check (student_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  student_name text not null check (char_length(student_name) between 1 and 120),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'in_progress', 'submitted', 'auto_submitted')),
  activity text not null default 'active' check (activity in ('active', 'away', 'idle')),
  activity_since timestamptz not null default now(),
  violation_count int not null default 0,
  attempt int not null default 1,  -- 2, 3, … after the teacher allows a retake
  last_seen_at timestamptz not null default now(),
  started_at timestamptz,
  submitted_at timestamptz,
  score numeric,
  max_score numeric,
  -- points the teacher took off (e.g. caught cheating); subtracted from the graded score
  deduction numeric not null default 0 check (deduction >= 0),
  -- personal code for "Check my score", set when the exam is submitted
  result_code text,
  created_at timestamptz not null default now(),
  unique (exam_id, student_email)
);
create index exam_sessions_exam_idx on public.exam_sessions (exam_id);

-- Kept apart from exam_sessions so the secret never reaches the teacher's
-- browser through queries or realtime. No policies: only the functions below read it.
create table public.session_tokens (
  session_id uuid primary key references public.exam_sessions (id) on delete cascade,
  token uuid not null unique default gen_random_uuid()
);

create table public.session_events (
  id bigint generated always as identity primary key,
  session_id uuid not null references public.exam_sessions (id) on delete cascade,
  exam_id uuid not null references public.exams (id) on delete cascade,
  type text not null check (type in (
    'join_requested', 'approved', 'rejected', 'started',
    'left', 'returned', 'idle', 'idle_ended',
    'blocked_action', 'fullscreen_exit',
    'submitted', 'auto_submitted',
    'retake_allowed', 'points_deducted', 'deduction_undone'
  )),
  counted boolean not null default false,  -- true when this event added a violation
  violation_number int,                    -- the count after this event, when counted
  duration_seconds int,                    -- for 'returned' / 'idle_ended'
  points numeric,                          -- for 'points_deducted' / 'deduction_undone'
  detail text,                             -- e.g. 'copy', 'right_click', 'exam_closed', a deduction reason
  created_at timestamptz not null default now()
);
create index session_events_exam_idx on public.session_events (exam_id, created_at desc);
create index session_events_session_idx on public.session_events (session_id, created_at desc);

create table public.answers (
  session_id uuid not null references public.exam_sessions (id) on delete cascade,
  question_id uuid not null references public.questions (id) on delete cascade,
  answer text not null default '' check (char_length(answer) <= 2000),
  is_correct boolean,
  points_awarded numeric,
  overridden boolean not null default false,  -- teacher corrected the grade by hand
  updated_at timestamptz not null default now(),
  primary key (session_id, question_id)
);

-- Accounts allowed to act as teachers. There is no sign-up page; the teacher
-- account is created by supabase/seed-teacher.sql. Any other Supabase user
-- (e.g. someone calling the sign-up API directly) can't create or see exams.
create table public.teachers (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Row Level Security (teachers)
-- ---------------------------------------------------------------------

create or replace function public.is_teacher()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.teachers t where t.user_id = (select auth.uid()));
$$;

create or replace function public.owns_exam(p_exam_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.exams e
    where e.id = p_exam_id and e.teacher_id = (select auth.uid())
  );
$$;

create or replace function public.owns_session(p_session_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.exam_sessions s
    join public.exams e on e.id = s.exam_id
    where s.id = p_session_id and e.teacher_id = (select auth.uid())
  );
$$;

alter table public.teachers enable row level security;
alter table public.exams enable row level security;
alter table public.questions enable row level security;
alter table public.exam_sessions enable row level security;
alter table public.session_tokens enable row level security;
alter table public.session_events enable row level security;
alter table public.answers enable row level security;

create policy "teachers manage own exams" on public.exams
  for all to authenticated
  using (teacher_id = (select auth.uid()) and public.is_teacher())
  with check (teacher_id = (select auth.uid()) and public.is_teacher());

create policy "teachers manage questions of own exams" on public.questions
  for all to authenticated
  using (public.owns_exam(exam_id))
  with check (public.owns_exam(exam_id));

create policy "teachers read sessions of own exams" on public.exam_sessions
  for select to authenticated using (public.owns_exam(exam_id));
create policy "teachers remove sessions of own exams" on public.exam_sessions
  for delete to authenticated using (public.owns_exam(exam_id));

create policy "teachers read events of own exams" on public.session_events
  for select to authenticated using (public.owns_exam(exam_id));

create policy "teachers read answers of own exams" on public.answers
  for select to authenticated using (public.owns_session(session_id));

-- ---------------------------------------------------------------------
-- Grading
-- ---------------------------------------------------------------------

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

-- ---------------------------------------------------------------------
-- Student API (no account — authenticated by session token)
-- ---------------------------------------------------------------------

create or replace function public.session_for_token(p_token uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select session_id from public.session_tokens where token = p_token;
$$;

create or replace function public.student_join(p_code text, p_email text, p_name text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_exam public.exams;
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_name text := btrim(coalesce(p_name, ''));
  v_session_id uuid;
  v_token uuid;
begin
  select * into v_exam from public.exams where code = upper(btrim(coalesce(p_code, '')));
  if v_exam.id is null then
    raise exception 'EXAM_NOT_FOUND' using hint = 'Check the exam code with your teacher.';
  end if;
  if v_exam.status <> 'open' then
    raise exception 'EXAM_NOT_OPEN' using hint = 'This exam is not accepting students right now.';
  end if;
  if v_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'INVALID_EMAIL' using hint = 'Enter a valid email address.';
  end if;
  if char_length(v_name) not between 1 and 120 then
    raise exception 'INVALID_NAME' using hint = 'Enter your full name.';
  end if;
  if exists (select 1 from public.exam_sessions where exam_id = v_exam.id and student_email = v_email) then
    raise exception 'ALREADY_JOINED'
      using hint = 'This email already joined. Continue on the device you used, or ask your teacher to remove your entry.';
  end if;

  insert into public.exam_sessions (exam_id, student_email, student_name)
  values (v_exam.id, v_email, v_name)
  returning id into v_session_id;

  insert into public.session_tokens (session_id) values (v_session_id)
  returning token into v_token;

  insert into public.session_events (session_id, exam_id, type)
  values (v_session_id, v_exam.id, 'join_requested');

  return jsonb_build_object('token', v_token, 'code', v_exam.code);
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

create or replace function public.student_start(p_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session_id uuid := public.session_for_token(p_token);
  s public.exam_sessions;
begin
  select * into s from public.exam_sessions where id = v_session_id for update;
  if s.id is null then
    raise exception 'INVALID_TOKEN';
  end if;
  if not exists (select 1 from public.exams where id = s.exam_id and status = 'open') then
    raise exception 'EXAM_NOT_OPEN';
  end if;

  if s.status = 'approved' then
    update public.exam_sessions
    set status = 'in_progress', started_at = now(), activity = 'active', activity_since = now(), last_seen_at = now()
    where id = s.id;
    insert into public.session_events (session_id, exam_id, type) values (s.id, s.exam_id, 'started');
  elsif s.status <> 'in_progress' then
    raise exception 'NOT_APPROVED';
  end if;

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
  select * into s from public.exam_sessions where id = v_session_id;
  if s.id is null then
    raise exception 'INVALID_TOKEN';
  end if;
  if s.status <> 'in_progress' then
    raise exception 'NOT_IN_PROGRESS';
  end if;
  if not exists (select 1 from public.questions where id = p_question_id and exam_id = s.exam_id) then
    raise exception 'INVALID_QUESTION';
  end if;

  insert into public.answers (session_id, question_id, answer, updated_at)
  values (s.id, p_question_id, left(coalesce(p_answer, ''), 2000), now())
  on conflict (session_id, question_id)
  do update set answer = excluded.answer, updated_at = now();
end;
$$;

-- Proctoring events from the student's browser.
--   'left'           → Alt+Tab / switched tab / minimized   (always a violation)
--   'returned'       → came back; p_duration = seconds away
--   'idle'           → no activity for the idle limit     (violation only if the teacher enabled it)
--   'idle_ended'     → active again; p_duration = seconds idle
--   'blocked_action' → right-click / copy / paste / shortcut (logged, never a violation)
--   'fullscreen_exit'→ left fullscreen                       (logged, never a violation)
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
  v_counted boolean := false;
  v_count int;
  v_duration int := least(greatest(coalesce(p_duration, 0), 0), 86400);
  v_detail text := left(p_detail, 40);
begin
  if v_session_id is null then
    raise exception 'INVALID_TOKEN';
  end if;

  -- Row lock so two quick events can't both miss the auto-submit threshold.
  select * into s from public.exam_sessions where id = v_session_id for update;
  select * into e from public.exams where id = s.exam_id;

  update public.exam_sessions set last_seen_at = now() where id = s.id;

  if s.status <> 'in_progress' then
    return public.student_state(p_token);
  end if;

  if p_type = 'left' then
    if s.activity <> 'away' then  -- blur + visibilitychange fire together; count once
      v_counted := true;
      update public.exam_sessions
      set activity = 'away', activity_since = now(), violation_count = violation_count + 1
      where id = s.id
      returning violation_count into v_count;
      insert into public.session_events (session_id, exam_id, type, counted, violation_number)
      values (s.id, s.exam_id, 'left', true, v_count);
    end if;

  elsif p_type = 'returned' then
    if s.activity = 'away' then
      update public.exam_sessions set activity = 'active', activity_since = now() where id = s.id;
      insert into public.session_events (session_id, exam_id, type, duration_seconds)
      values (s.id, s.exam_id, 'returned', greatest(v_duration, extract(epoch from now() - s.activity_since)::int));
    end if;

  elsif p_type = 'idle' then
    if s.activity = 'active' then
      v_counted := e.idle_counts_as_violation;
      update public.exam_sessions
      set activity = 'idle', activity_since = now(),
          violation_count = violation_count + case when v_counted then 1 else 0 end
      where id = s.id
      returning violation_count into v_count;
      insert into public.session_events (session_id, exam_id, type, counted, violation_number)
      values (s.id, s.exam_id, 'idle', v_counted, case when v_counted then v_count end);
    end if;

  elsif p_type = 'idle_ended' then
    if s.activity = 'idle' then
      update public.exam_sessions set activity = 'active', activity_since = now() where id = s.id;
      insert into public.session_events (session_id, exam_id, type, duration_seconds)
      values (s.id, s.exam_id, 'idle_ended', greatest(v_duration, extract(epoch from now() - s.activity_since)::int));
    end if;

  elsif p_type in ('blocked_action', 'fullscreen_exit') then
    -- Throttle: one log line per kind every 3 seconds.
    if not exists (
      select 1 from public.session_events
      where session_id = s.id and type = p_type and detail is not distinct from v_detail
        and created_at > now() - interval '3 seconds'
    ) then
      insert into public.session_events (session_id, exam_id, type, detail)
      values (s.id, s.exam_id, p_type, v_detail);
    end if;

  else
    raise exception 'INVALID_EVENT';
  end if;

  if v_counted and v_count >= e.max_violations then
    perform public.finish_session(s.id, true, 'max_violations');
  end if;

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
begin
  if v_session_id is null then
    raise exception 'INVALID_TOKEN';
  end if;
  perform public.finish_session(v_session_id, false, null);
  return public.student_state(p_token);
end;
$$;

-- ---------------------------------------------------------------------
-- Teacher actions (need ownership; logged as events)
-- ---------------------------------------------------------------------

create or replace function public.teacher_review_request(p_session_id uuid, p_approve boolean)
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
  if s.status not in ('pending', 'rejected', 'approved') then
    return; -- already taking or finished the exam
  end if;
  update public.exam_sessions
  set status = case when p_approve then 'approved' else 'rejected' end
  where id = s.id;
  insert into public.session_events (session_id, exam_id, type)
  values (s.id, s.exam_id, case when p_approve then 'approved' else 'rejected' end);
end;
$$;

create or replace function public.teacher_approve_all(p_exam_id uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count int;
begin
  if not public.owns_exam(p_exam_id) then
    raise exception 'FORBIDDEN';
  end if;
  with approved as (
    update public.exam_sessions set status = 'approved'
    where exam_id = p_exam_id and status = 'pending'
    returning id
  )
  insert into public.session_events (session_id, exam_id, type)
  select id, p_exam_id, 'approved' from approved;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.teacher_force_submit(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.owns_session(p_session_id) then
    raise exception 'FORBIDDEN';
  end if;
  perform public.finish_session(p_session_id, false, 'teacher');
end;
$$;

create or replace function public.teacher_close_exam(p_exam_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not public.owns_exam(p_exam_id) then
    raise exception 'FORBIDDEN';
  end if;
  update public.exams set status = 'closed', updated_at = now() where id = p_exam_id;
  for v_id in select id from public.exam_sessions where exam_id = p_exam_id and status = 'in_progress' loop
    perform public.finish_session(v_id, false, 'exam_closed');
  end loop;
end;
$$;

create or replace function public.teacher_regrade_exam(p_exam_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not public.owns_exam(p_exam_id) then
    raise exception 'FORBIDDEN';
  end if;
  for v_id in select id from public.exam_sessions
              where exam_id = p_exam_id and status in ('submitted', 'auto_submitted') loop
    perform public.grade_session(v_id);
  end loop;
end;
$$;

-- Manual grade correction for one answer (e.g. an identification spelling variant).
create or replace function public.teacher_override_answer(p_session_id uuid, p_question_id uuid, p_is_correct boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.owns_session(p_session_id) then
    raise exception 'FORBIDDEN';
  end if;
  insert into public.answers (session_id, question_id, answer, is_correct, overridden)
  values (p_session_id, p_question_id, '', p_is_correct, true)
  on conflict (session_id, question_id)
  do update set is_correct = excluded.is_correct, overridden = true;
  perform public.grade_session(p_session_id);
end;
$$;

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

-- Gives back the points of one earlier deduction (e.g. deducted by mistake).
-- Only deductions from the student's current attempt can be undone, once each.
create or replace function public.teacher_undo_deduction(p_event_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  ev public.session_events;
  s public.exam_sessions;
begin
  select * into ev from public.session_events where id = p_event_id and type = 'points_deducted';
  if ev.id is null or not public.owns_session(ev.session_id) then
    raise exception 'DEDUCTION_NOT_FOUND' using hint = 'That deduction no longer exists.';
  end if;
  select * into s from public.exam_sessions where id = ev.session_id for update;
  if exists (
    select 1 from public.session_events
    where session_id = ev.session_id and type = 'deduction_undone' and detail = ev.id::text
  ) then
    raise exception 'ALREADY_UNDONE' using hint = 'That deduction was already undone.';
  end if;
  if exists (
    select 1 from public.session_events
    where session_id = ev.session_id and type = 'retake_allowed' and id > ev.id
  ) then
    raise exception 'OLD_ATTEMPT' using hint = 'That deduction was for an earlier attempt, which was already reset.';
  end if;

  update public.exam_sessions set deduction = greatest(0, deduction - ev.points) where id = s.id;

  insert into public.session_events (session_id, exam_id, type, points, detail)
  values (s.id, s.exam_id, 'deduction_undone', ev.points, ev.id::text);

  if s.status in ('submitted', 'auto_submitted') then
    perform public.grade_session(s.id);
  end if;
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

-- ---------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------

-- Functions are executable by PUBLIC by default; lock them all down first.
revoke execute on all functions in schema public from public, anon, authenticated;

grant execute on function public.student_join(text, text, text) to anon, authenticated;
grant execute on function public.student_state(uuid) to anon, authenticated;
grant execute on function public.student_questions(uuid) to anon, authenticated;
grant execute on function public.student_start(uuid) to anon, authenticated;
grant execute on function public.student_save_answer(uuid, uuid, text) to anon, authenticated;
grant execute on function public.student_report(uuid, text, text, int) to anon, authenticated;
grant execute on function public.student_submit(uuid) to anon, authenticated;
grant execute on function public.student_lookup_result(text, text, text) to anon, authenticated;

grant execute on function public.teacher_review_request(uuid, boolean) to authenticated;
grant execute on function public.teacher_approve_all(uuid) to authenticated;
grant execute on function public.teacher_force_submit(uuid) to authenticated;
grant execute on function public.teacher_close_exam(uuid) to authenticated;
grant execute on function public.teacher_regrade_exam(uuid) to authenticated;
grant execute on function public.teacher_override_answer(uuid, uuid, boolean) to authenticated;
grant execute on function public.teacher_allow_retake(uuid) to authenticated;
grant execute on function public.teacher_duplicate_exam(uuid) to authenticated;
grant execute on function public.teacher_deduct_points(uuid, numeric, text) to authenticated;
grant execute on function public.teacher_undo_deduction(bigint) to authenticated;

-- Used inside RLS policies and column defaults.
grant execute on function public.is_teacher() to authenticated;
grant execute on function public.owns_exam(uuid) to authenticated;
grant execute on function public.owns_session(uuid) to authenticated;
grant execute on function public.generate_exam_code() to authenticated;

-- ---------------------------------------------------------------------
-- Realtime (teacher dashboard live updates; RLS still applies)
-- ---------------------------------------------------------------------
alter publication supabase_realtime add table public.exam_sessions, public.session_events;
