alter table public.answers
  add column manual_points numeric check (manual_points is null or manual_points >= 0);

-- Regrading preserves a teacher-entered point value while clamping it to the
-- question's current maximum. Older correct/wrong overrides remain supported.
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
  where a.session_id = p_session_id and q.id = a.question_id and not a.overridden;

  update public.answers a
  set points_awarded = case
        when a.manual_points is not null then least(a.manual_points, q.points)
        when a.is_correct then q.points
        else 0
      end,
      is_correct = case
        when a.manual_points is not null then a.manual_points >= q.points
        else a.is_correct
      end
  from public.questions q
  where a.session_id = p_session_id and q.id = a.question_id and a.overridden;

  update public.exam_sessions s
  set score = greatest(0, coalesce((select sum(a.points_awarded) from public.answers a where a.session_id = p_session_id), 0) - s.deduction),
      max_score = coalesce((select sum(q.points) from public.questions q where q.exam_id = v_exam_id), 0)
  where s.id = p_session_id;
end;
$$;

-- Quick correct/wrong actions clear any prior partial-credit score.
create or replace function public.teacher_override_answer(p_session_id uuid, p_question_id uuid, p_is_correct boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.owns_session(p_session_id) then raise exception 'FORBIDDEN'; end if;
  insert into public.answers (session_id, question_id, answer, is_correct, overridden, manual_points)
  values (p_session_id, p_question_id, '', p_is_correct, true, null)
  on conflict (session_id, question_id)
  do update set is_correct = excluded.is_correct, overridden = true, manual_points = null;
  perform public.grade_session(p_session_id);
end;
$$;

create or replace function public.teacher_set_answer_score(p_session_id uuid, p_question_id uuid, p_points numeric)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  q public.questions;
begin
  if not public.owns_session(p_session_id) then raise exception 'FORBIDDEN'; end if;
  select questions.* into q
  from public.questions
  join public.exam_sessions on exam_sessions.exam_id = questions.exam_id
  where exam_sessions.id = p_session_id and questions.id = p_question_id;
  if q.id is null then raise exception 'INVALID_QUESTION'; end if;
  if q.type not in ('essay', 'identification') then
    raise exception 'MANUAL_SCORE_NOT_ALLOWED' using hint = 'Partial scores are available for essay and identification responses.';
  end if;
  if p_points is null or p_points < 0 or p_points > q.points then
    raise exception 'INVALID_SCORE' using hint = format('Enter a score from 0 to %s.', q.points);
  end if;

  insert into public.answers (session_id, question_id, answer, is_correct, overridden, manual_points, points_awarded)
  values (p_session_id, p_question_id, '', p_points = q.points, true, p_points, p_points)
  on conflict (session_id, question_id)
  do update set is_correct = excluded.is_correct,
                overridden = true,
                manual_points = excluded.manual_points,
                points_awarded = excluded.points_awarded;
  perform public.grade_session(p_session_id);
end;
$$;

grant execute on function public.teacher_set_answer_score(uuid, uuid, numeric) to authenticated;
