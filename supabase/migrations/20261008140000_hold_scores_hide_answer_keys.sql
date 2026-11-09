-- Students may review only their own submitted responses. Do not include the
-- answer key, correctness flags, or per-question scores in this response.
-- Scores stay hidden until the scheduled deadline or until a teacher closes
-- an unscheduled exam. The existing after-release preference can hold them
-- longer once the exam has ended.
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
  v_results_visible := v_finished and v_exam_ended and (e.show_score = 'immediately' or e.results_released);

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
      'your_answer', a.answer
    ) || case when v_results_visible then jsonb_build_object(
      'points', q.points,
      'points_awarded', a.points_awarded
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
      'auto_submit_reason', v_auto_reason
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
