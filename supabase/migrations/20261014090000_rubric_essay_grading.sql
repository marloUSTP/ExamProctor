-- Rubrics and AI suggestions are teacher-only. Only explicit teacher actions
-- award essay points; pending essays keep the whole student's score unpublished.
-- Some older deployments have the result-state function but missed the column.
alter table public.exams add column if not exists results_hidden boolean not null default false;
alter table public.questions add column if not exists rubric jsonb;
alter table public.questions add column if not exists rubric_source_text text not null default '' check (char_length(rubric_source_text) <= 30000);
alter table public.answers
  add column if not exists manual_points numeric check (manual_points is null or manual_points >= 0),
  add column if not exists approval_snapshot jsonb,
  add column if not exists graded_at timestamptz,
  add column if not exists graded_by uuid references auth.users(id),
  add column if not exists rubric_grading jsonb;
-- Match the existing essay editor's 5,000-character limit.
alter table public.answers drop constraint if exists answers_answer_check;
alter table public.answers add constraint answers_answer_check check (char_length(answer) <= 5000);

create or replace function public.question_grading_snapshot(p_question_id uuid)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('prompt', q.prompt, 'points', q.points, 'rubric', q.rubric)
  from public.questions q where q.id = p_question_id;
$$;

create or replace function public.validate_question_rubric()
returns trigger language plpgsql set search_path = '' as $$
declare c jsonb; total numeric := 0; ids text[] := '{}';
begin
  if new.rubric is null then return new; end if;
  if new.type <> 'essay' or jsonb_typeof(new.rubric) <> 'object'
    or jsonb_typeof(new.rubric->'criteria') is distinct from 'array' then
    raise exception 'INVALID_RUBRIC' using hint = 'Only essays can have a rubric with criteria.';
  end if;
  if jsonb_array_length(new.rubric->'criteria') not between 1 and 12 then
    raise exception 'INVALID_RUBRIC' using hint = 'Add between 1 and 12 criteria.';
  end if;
  for c in select value from jsonb_array_elements(new.rubric->'criteria') loop
    if jsonb_typeof(c->'id') is distinct from 'string' or (c->>'id') !~ '^[a-zA-Z0-9_-]{1,64}$'
      or (c->>'id') = any(ids)
      or jsonb_typeof(c->'name') is distinct from 'string' or char_length(btrim(c->>'name')) not between 1 and 200
      or jsonb_typeof(c->'description') is distinct from 'string' or char_length(btrim(c->>'description')) not between 1 and 4000
      or jsonb_typeof(c->'max_points') is distinct from 'number' then
      raise exception 'INVALID_RUBRIC' using hint = 'Every criterion needs a unique ID, name, scoring descriptions and numeric point limit.';
    end if;
    if (c->>'max_points')::numeric <= 0 or (c->>'max_points')::numeric > 100 then raise exception 'INVALID_RUBRIC'; end if;
    total := total + (c->>'max_points')::numeric;
    ids := array_append(ids, c->>'id');
  end loop;
  if total <> new.points then raise exception 'INVALID_RUBRIC' using hint = 'Rubric points must equal the question point limit.'; end if;
  return new;
end;
$$;
create trigger validate_question_rubric before insert or update on public.questions
for each row execute function public.validate_question_rubric();

create table public.essay_suggestions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null,
  question_id uuid not null,
  attempt int not null,
  answer_snapshot text not null,
  question_snapshot jsonb not null,
  grading jsonb not null,
  model text not null,
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  approved_by uuid references auth.users(id),
  final_grading jsonb,
  foreign key (session_id, question_id) references public.answers(session_id, question_id) on delete cascade
);
create index essay_suggestions_answer_idx on public.essay_suggestions(session_id, question_id, created_at desc);
alter table public.essay_suggestions enable row level security;
create policy "teachers read own essay suggestions" on public.essay_suggestions
  for select to authenticated using (public.owns_session(session_id));
revoke all on public.essay_suggestions from anon, authenticated;
grant select on public.essay_suggestions to authenticated;

-- Preserve previously entered teacher grades when upgrading.
update public.answers a set approval_snapshot = public.question_grading_snapshot(a.question_id), graded_at = a.updated_at
from public.questions q where q.id = a.question_id and q.type = 'essay' and a.overridden;

create or replace function public.session_needs_grading(p_session_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.questions q
    join public.exam_sessions s on s.exam_id = q.exam_id
    left join public.answers a on a.question_id = q.id and a.session_id = s.id
    where s.id = p_session_id and q.type = 'essay'
      and (not coalesce(a.overridden, false) or a.approval_snapshot is distinct from public.question_grading_snapshot(q.id))
  );
$$;

create or replace function public.grade_session(p_session_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_exam_id uuid;
begin
  select exam_id into v_exam_id from public.exam_sessions where id = p_session_id for update;
  -- Blank essays also require an explicit teacher-approved zero.
  insert into public.answers(session_id, question_id, answer)
    select p_session_id, q.id, '' from public.questions q where q.exam_id = v_exam_id and q.type = 'essay'
    on conflict do nothing;
  update public.answers a set
    is_correct = case when q.type = 'essay' then null
      when q.type = 'identification' then exists (select 1 from unnest(q.correct_answers) k
        where public.normalize_answer(k) = public.normalize_answer(a.answer) and public.normalize_answer(a.answer) <> '')
      else a.answer = any(q.correct_answers) end,
    points_awarded = case when q.type = 'essay' then null
      when q.type = 'identification' then case when exists (select 1 from unnest(q.correct_answers) k
        where public.normalize_answer(k) = public.normalize_answer(a.answer) and public.normalize_answer(a.answer) <> '') then q.points else 0 end
      when a.answer = any(q.correct_answers) then q.points else 0 end
  from public.questions q where a.session_id = p_session_id and q.id = a.question_id and not a.overridden;
  update public.answers a set
    points_awarded = case
      when q.type = 'essay' and a.approval_snapshot is distinct from public.question_grading_snapshot(q.id) then null
      when a.manual_points is not null then least(a.manual_points, q.points)
      when a.is_correct then q.points else 0 end,
    is_correct = case
      when q.type = 'essay' and a.approval_snapshot is distinct from public.question_grading_snapshot(q.id) then null
      when a.manual_points is not null then a.manual_points >= q.points else a.is_correct end
  from public.questions q where a.session_id = p_session_id and q.id = a.question_id and a.overridden;
  update public.exam_sessions s set
    score = case when public.session_needs_grading(s.id) then null else greatest(0,
      coalesce((select sum(a.points_awarded) from public.answers a where a.session_id = s.id), 0) - s.deduction) end,
    max_score = coalesce((select sum(q.points) from public.questions q where q.exam_id = v_exam_id), 0)
  where s.id = p_session_id;
end;
$$;

create or replace function public.teacher_set_answer_score(p_session_id uuid, p_question_id uuid, p_points numeric)
returns void language plpgsql security definer set search_path = '' as $$
declare q public.questions; s public.exam_sessions;
begin
  if not public.owns_session(p_session_id) then raise exception 'FORBIDDEN'; end if;
  select * into q from public.questions where id = p_question_id for share;
  select * into s from public.exam_sessions where id = p_session_id for update;
  if q.id is null or q.exam_id <> s.exam_id then raise exception 'INVALID_QUESTION'; end if;
  if s.status not in ('submitted', 'auto_submitted') then raise exception 'NOT_FINISHED'; end if;
  if q.type not in ('essay', 'identification') then raise exception 'MANUAL_SCORE_NOT_ALLOWED'; end if;
  if p_points is null or p_points::text in ('NaN','Infinity','-Infinity') or p_points < 0 or p_points > q.points then
    raise exception 'INVALID_SCORE' using hint = 'Enter a finite score within the question point limit.';
  end if;
  insert into public.answers(session_id, question_id, answer, is_correct, overridden, manual_points, points_awarded, approval_snapshot, graded_at, graded_by)
  values (s.id, q.id, '', p_points = q.points, true, p_points, p_points, public.question_grading_snapshot(q.id), now(), auth.uid())
  on conflict(session_id, question_id) do update set is_correct = excluded.is_correct, overridden = true,
    manual_points = excluded.manual_points, points_awarded = excluded.points_awarded, approval_snapshot = excluded.approval_snapshot,
    graded_at = excluded.graded_at, graded_by = excluded.graded_by, rubric_grading = null;
  perform public.grade_session(s.id);
end;
$$;

create or replace function public.teacher_override_answer(p_session_id uuid, p_question_id uuid, p_is_correct boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare q public.questions; s public.exam_sessions;
begin
  if not public.owns_session(p_session_id) then raise exception 'FORBIDDEN'; end if;
  select * into q from public.questions where id = p_question_id for share;
  select * into s from public.exam_sessions where id = p_session_id for update;
  if q.id is null or q.exam_id <> s.exam_id or p_is_correct is null then raise exception 'INVALID_QUESTION'; end if;
  if s.status not in ('submitted', 'auto_submitted') then raise exception 'NOT_FINISHED'; end if;
  if q.type in ('essay', 'identification') then
    perform public.teacher_set_answer_score(s.id, q.id, case when p_is_correct then q.points else 0 end);
    return;
  end if;
  insert into public.answers(session_id, question_id, answer, is_correct, overridden, manual_points, graded_at, graded_by)
  values (s.id, q.id, '', p_is_correct, true, null, now(), auth.uid())
  on conflict(session_id, question_id) do update set is_correct = excluded.is_correct, overridden = true,
    manual_points = null, graded_at = excluded.graded_at, graded_by = excluded.graded_by;
  perform public.grade_session(s.id);
end;
$$;

-- Validate both model output and teacher-adjusted criterion scores inside the DB.
create or replace function public.validate_essay_grading(p_grading jsonb, p_rubric jsonb, p_answer text)
returns numeric language plpgsql set search_path = '' as $$
declare c jsonb; r jsonb; ids text[] := '{}'; total numeric := 0;
begin
  if jsonb_typeof(p_grading) is distinct from 'object' or jsonb_typeof(p_grading->'criteria') is distinct from 'array'
    or jsonb_typeof(p_grading->'feedback') is distinct from 'string' or char_length(p_grading->>'feedback') > 4000 then
    raise exception 'INVALID_GRADING';
  end if;
  if jsonb_array_length(p_grading->'criteria') <> jsonb_array_length(p_rubric->'criteria') then raise exception 'INVALID_GRADING'; end if;
  for c in select value from jsonb_array_elements(p_grading->'criteria') loop
    select value into r from jsonb_array_elements(p_rubric->'criteria') where value->>'id' = c->>'criterion_id';
    if r is null or (c->>'criterion_id') = any(ids) or jsonb_typeof(c->'points') is distinct from 'number'
      or jsonb_typeof(c->'reason') is distinct from 'string' or char_length(btrim(c->>'reason')) not between 1 and 2000
      or jsonb_typeof(c->'evidence') is distinct from 'string' or char_length(c->>'evidence') > 2000 then
      raise exception 'INVALID_GRADING';
    end if;
    if (c->>'points')::numeric < 0 or (c->>'points')::numeric > (r->>'max_points')::numeric then raise exception 'INVALID_SCORE'; end if;
    if c->>'evidence' <> '' and strpos(p_answer, c->>'evidence') = 0 then raise exception 'INVALID_EVIDENCE'; end if;
    ids := array_append(ids, c->>'criterion_id'); total := total + (c->>'points')::numeric;
  end loop;
  return total;
end;
$$;

create or replace function public.teacher_save_essay_suggestion(
  p_session_id uuid, p_question_id uuid, p_attempt int, p_answer text, p_snapshot jsonb, p_grading jsonb, p_model text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.exam_sessions; q public.questions; a public.answers; result public.essay_suggestions;
begin
  if not public.owns_session(p_session_id) then raise exception 'FORBIDDEN'; end if;
  select * into q from public.questions where id = p_question_id for share;
  select * into s from public.exam_sessions where id = p_session_id for update;
  select * into a from public.answers where session_id = s.id and question_id = q.id;
  if q.id is null or q.exam_id <> s.exam_id or q.type <> 'essay' or q.rubric is null
    or s.status not in ('submitted','auto_submitted') or s.attempt is distinct from p_attempt
    or p_answer is distinct from coalesce(a.answer, '') or p_snapshot is distinct from public.question_grading_snapshot(q.id)
    or (a.overridden and a.approval_snapshot = p_snapshot) then
    raise exception 'STALE_GRADING' using hint = 'The answer, rubric or approval changed. Refresh before grading again.';
  end if;
  if p_model is null or char_length(p_model) not between 1 and 200 then raise exception 'INVALID_MODEL'; end if;
  perform public.validate_essay_grading(p_grading, q.rubric, p_answer);
  insert into public.answers(session_id, question_id, answer) values(s.id, q.id, '') on conflict do nothing;
  insert into public.essay_suggestions(session_id, question_id, attempt, answer_snapshot, question_snapshot, grading, model)
    values(s.id, q.id, s.attempt, p_answer, p_snapshot, p_grading, p_model) returning * into result;
  return to_jsonb(result);
end;
$$;

create or replace function public.teacher_approve_essay_suggestion(p_suggestion_id uuid, p_final_grading jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare proposal public.essay_suggestions; s public.exam_sessions; q public.questions; a public.answers; total numeric;
begin
  select * into proposal from public.essay_suggestions where id = p_suggestion_id;
  if proposal.id is null or not public.owns_session(proposal.session_id) then raise exception 'FORBIDDEN'; end if;
  select * into q from public.questions where id = proposal.question_id for share;
  select * into s from public.exam_sessions where id = proposal.session_id for update;
  select * into proposal from public.essay_suggestions where id = p_suggestion_id for update;
  select * into a from public.answers where session_id = s.id and question_id = q.id;
  if proposal.approved_at is not null or q.type <> 'essay' or s.status not in ('submitted','auto_submitted')
    or s.attempt <> proposal.attempt or a.answer is distinct from proposal.answer_snapshot
    or public.question_grading_snapshot(q.id) is distinct from proposal.question_snapshot
    or (a.overridden and a.approval_snapshot = proposal.question_snapshot) then
    raise exception 'STALE_GRADING' using hint = 'The answer, rubric or approval changed. Refresh before approving.';
  end if;
  total := public.validate_essay_grading(p_final_grading, q.rubric, a.answer);
  perform public.teacher_set_answer_score(s.id, q.id, total);
  update public.answers set rubric_grading = p_final_grading where session_id = s.id and question_id = q.id;
  update public.essay_suggestions set approved_at = now(), approved_by = auth.uid(), final_grading = p_final_grading
  where id = proposal.id;
end;
$$;

create or replace function public.teacher_approve_rubric_answer(
  p_session_id uuid, p_question_id uuid, p_attempt int, p_answer text, p_snapshot jsonb, p_grading jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare s public.exam_sessions; q public.questions; a public.answers; total numeric;
begin
  if not public.owns_session(p_session_id) then raise exception 'FORBIDDEN'; end if;
  select * into q from public.questions where id = p_question_id for share;
  select * into s from public.exam_sessions where id = p_session_id for update;
  select * into a from public.answers where session_id = s.id and question_id = q.id;
  if q.id is null or q.exam_id <> s.exam_id or q.type <> 'essay' or q.rubric is null
    or s.status not in ('submitted','auto_submitted') or s.attempt is distinct from p_attempt
    or p_answer is distinct from coalesce(a.answer, '') or p_snapshot is distinct from public.question_grading_snapshot(q.id) then
    raise exception 'STALE_GRADING' using hint = 'The answer, rubric or attempt changed. Refresh before approving.';
  end if;
  total := public.validate_essay_grading(p_grading, q.rubric, p_answer);
  perform public.teacher_set_answer_score(s.id, q.id, total);
  update public.answers set rubric_grading = p_grading where session_id = s.id and question_id = q.id;
end;
$$;

-- Any changed grading inputs require fresh approval; previous manual points
-- and AI proposals remain stored for review, never silently repurposed.
create or replace function public.regrade_changed_question()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_session_id uuid; v_exam_id uuid;
begin
  if tg_op = 'UPDATE' and row(old.prompt, old.points, old.rubric, old.type, old.correct_answers)
    is not distinct from row(new.prompt, new.points, new.rubric, new.type, new.correct_answers) then return null; end if;
  v_exam_id := case when tg_op = 'DELETE' then old.exam_id else new.exam_id end;
  for v_session_id in select s.id from public.exam_sessions s where s.exam_id = v_exam_id and s.status in ('submitted','auto_submitted') loop
    perform public.grade_session(v_session_id);
  end loop;
  return null;
end;
$$;
create trigger regrade_changed_question after insert or update or delete on public.questions
for each row execute function public.regrade_changed_question();

-- Preserve the entire essay accepted by the existing 5,000-character editor.
-- Lock the attempt so a concurrent submission cannot race an answer save.
create or replace function public.student_save_answer(p_token uuid, p_question_id uuid, p_answer text)
returns void language plpgsql security definer set search_path = '' as $$
declare s public.exam_sessions; e public.exams; q public.questions; v_limit int;
begin
  select * into s from public.exam_sessions where id = public.session_for_token(p_token) for update;
  if s.id is null then raise exception 'INVALID_TOKEN'; end if;
  if s.status <> 'in_progress' then raise exception 'NOT_IN_PROGRESS'; end if;
  select * into e from public.exams where id = s.exam_id;
  if e.scheduled_end_at is not null and e.scheduled_end_at <= now() then
    perform public.finish_session(s.id, true, 'time_limit');
    return;
  end if;
  select * into q from public.questions where id = p_question_id and exam_id = s.exam_id;
  if q.id is null then raise exception 'INVALID_QUESTION'; end if;
  v_limit := case when q.type = 'essay' then 5000 else 2000 end;
  if char_length(coalesce(p_answer, '')) > v_limit then
    raise exception 'ANSWER_TOO_LONG' using hint = format('Keep this answer within %s characters.', v_limit);
  end if;
  insert into public.answers(session_id, question_id, answer, updated_at)
  values(s.id, q.id, coalesce(p_answer, ''), now())
  on conflict(session_id, question_id) do update set answer = excluded.answer, updated_at = now();
end;
$$;

revoke execute on function public.question_grading_snapshot(uuid), public.validate_question_rubric(), public.session_needs_grading(uuid),
  public.validate_essay_grading(jsonb,jsonb,text), public.regrade_changed_question(),
  public.teacher_save_essay_suggestion(uuid,uuid,int,text,jsonb,jsonb,text), public.teacher_approve_essay_suggestion(uuid,jsonb),
  public.teacher_approve_rubric_answer(uuid,uuid,int,text,jsonb,jsonb)
  from public, anon, authenticated;
grant execute on function public.teacher_set_answer_score(uuid,uuid,numeric),
  public.teacher_save_essay_suggestion(uuid,uuid,int,text,jsonb,jsonb,text), public.teacher_approve_essay_suggestion(uuid,jsonb),
  public.teacher_approve_rubric_answer(uuid,uuid,int,text,jsonb,jsonb) to authenticated;

-- Recalculate existing completed submissions so ungraded essays no longer
-- appear as a final zero. Approved manual grades are preserved above.
do $$ declare s record; begin
  for s in select id from public.exam_sessions where status in ('submitted','auto_submitted') loop
    perform public.grade_session(s.id);
  end loop;
end $$;

-- Student-facing grading visibility
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
  v_exam_ended boolean;
  v_results_visible boolean;
  v_review jsonb := null;
  v_auto_reason text;
begin
  select * into s from public.exam_sessions where id = p_session_id;
  select * into e from public.exams where id = s.exam_id;

  v_finished := s.status in ('submitted', 'auto_submitted');
  v_exam_ended := e.status = 'closed' or (e.scheduled_end_at is not null and e.scheduled_end_at <= now());
  v_results_visible := v_finished and not public.session_needs_grading(s.id) and s.score is not null and not e.results_hidden and (v_exam_ended or e.results_released);

  if s.status = 'auto_submitted' then
    select detail into v_auto_reason
    from public.session_events
    where session_id = s.id and type = 'auto_submitted'
    order by created_at desc limit 1;
  end if;

  if v_finished then
    select coalesce(jsonb_agg(jsonb_build_object(
      'question_id', q.id,
      'prompt', q.prompt,
      'type', q.type,
      'choices', q.choices,
      'choice_order', coalesce((
        select jsonb_agg(i order by
          case when e.shuffle_choices then md5(s.id::text || q.id::text || i::text) end, i)
        from generate_series(0, jsonb_array_length(q.choices) - 1) i
      ), '[]'::jsonb),
      'your_answer', a.answer
    ) || case when v_results_visible then jsonb_build_object(
      'correct_answers', to_jsonb(q.correct_answers),
      'points', q.points,
      'points_awarded', coalesce(a.points_awarded, 0),
      'rubric_feedback', a.rubric_grading->>'feedback',
      'rubric_scores', case when a.rubric_grading is not null then (
        select jsonb_agg(jsonb_build_object(
          'name', r.value->>'name', 'max_points', r.value->'max_points',
          'points', g.value->'points', 'reason', g.value->>'reason'
        ) order by r.ordinality)
        from jsonb_array_elements(q.rubric->'criteria') with ordinality r(value, ordinality)
        join jsonb_array_elements(a.rubric_grading->'criteria') g(value) on g.value->>'criterion_id' = r.value->>'id'
      ) else null end
    ) else '{}'::jsonb end order by q.position, q.created_at), '[]'::jsonb)
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
      'result_code', case when v_finished then s.result_code end,
      'auto_submit_reason', v_auto_reason,
      'grading_pending', v_finished and public.session_needs_grading(s.id)
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
      'question_count', (select count(*) from public.questions q where q.exam_id = e.id),
      'scheduled_start_at', e.scheduled_start_at,
      'scheduled_end_at', e.scheduled_end_at,
      'server_now', clock_timestamp()
    ),
    'review', v_review,
    'result', case when v_results_visible then jsonb_build_object(
      'score', s.score,
      'max_score', s.max_score
    ) else null end
  );
end;
$$;

-- Duplicated exams retain their rubrics and source text.
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

  insert into public.questions (exam_id, position, type, prompt, choices, correct_answers, points, rubric, rubric_source_text)
  select v_new_id, position, type, prompt, choices, correct_answers, points, rubric, rubric_source_text
  from public.questions
  where exam_id = p_exam_id;

  return v_new_id;
end;
$$;
