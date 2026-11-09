-- Allow 'essay' in questions table
alter table public.questions drop constraint if exists questions_type_check;
alter table public.questions add constraint questions_type_check 
  check (type in ('multiple_choice', 'true_false', 'identification', 'essay'));

-- Update grade_session function to safely handle essay questions
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
        when q.type = 'essay' then false
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
            when q.type = 'essay' then false
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
