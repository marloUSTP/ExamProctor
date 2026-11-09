-- Released results include graded points while essays await approval.
-- Final stored scores stay pending until every essay is approved.
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
  v_pending_questions integer;
  v_review jsonb := null;
  v_auto_reason text;
begin
  select * into s from public.exam_sessions where id = p_session_id;
  select * into e from public.exams where id = s.exam_id;

  v_finished := s.status in ('submitted', 'auto_submitted');
  v_exam_ended := e.status = 'closed' or (e.scheduled_end_at is not null and e.scheduled_end_at <= now());
  -- Release controls visibility independently of essay completion.
  v_results_visible := v_finished and not e.results_hidden and (v_exam_ended or e.results_released);
  select count(*) into v_pending_questions
  from public.questions q
  left join public.answers a on a.question_id = q.id and a.session_id = s.id
  where q.exam_id = e.id and q.type = 'essay'
    and (not coalesce(a.overridden, false)
      or a.approval_snapshot is distinct from public.question_grading_snapshot(q.id));

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
      'points_awarded', case when pending.needs_grading then null else coalesce(a.points_awarded, 0) end,
      'grading_pending', pending.needs_grading,
      'rubric_feedback', case when not pending.needs_grading then a.rubric_grading->>'feedback' end,
      'rubric_scores', case when not pending.needs_grading and a.rubric_grading is not null then (
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
    cross join lateral (
      select q.type = 'essay' and (not coalesce(a.overridden, false)
        or a.approval_snapshot is distinct from public.question_grading_snapshot(q.id)) as needs_grading
    ) pending
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
      'grading_pending', v_finished and v_pending_questions > 0
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
    'result', case when v_results_visible and (v_pending_questions > 0 or s.score is not null) then jsonb_build_object(
      -- Only graded answers contribute. Never publish a draft or stale essay approval.
      'score', case when v_pending_questions > 0 then greatest(0,
        coalesce((select sum((item->>'points_awarded')::numeric)
          from jsonb_array_elements(v_review) item), 0) - s.deduction) else s.score end,
      'max_score', coalesce(s.max_score, (select sum(q.points) from public.questions q where q.exam_id = e.id), 0),
      'is_partial', v_pending_questions > 0,
      'pending_questions', v_pending_questions
    ) else null end
  );
end;
$$;

notify pgrst, 'reload schema';
