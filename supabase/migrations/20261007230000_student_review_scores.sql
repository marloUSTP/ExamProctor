-- Give the student review the same per-question grade detail shown to the teacher.
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
             'points_awarded', a.points_awarded,
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
