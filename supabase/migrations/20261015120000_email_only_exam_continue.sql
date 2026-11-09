-- Existing students continue with exam code + email only. Unknown emails do
-- not create entries: the UI collects names and uses the checked registration RPC.
create or replace function public.student_join(p_code text, p_email text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  e public.exams;
  s public.exam_sessions;
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_token uuid;
begin
  select * into e from public.exams where code = upper(btrim(coalesce(p_code, '')));
  if e.id is null then raise exception 'EXAM_NOT_FOUND' using hint = 'Check the exam code with your teacher.'; end if;
  if v_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'INVALID_EMAIL' using hint = 'Enter a valid email address.'; end if;
  select * into s from public.exam_sessions where exam_id = e.id and student_email = v_email;
  if s.id is not null then
    select token into v_token from public.session_tokens where session_id = s.id;
    if v_token is null then raise exception 'INVALID_TOKEN' using hint = 'Your exam access could not be restored. Ask your teacher for help.'; end if;
    -- No identity, status, approval, answers, timing or violation changes.
    return jsonb_build_object('token', v_token, 'code', e.code);
  end if;
  if e.status = 'closed' or (e.scheduled_end_at is null and e.status <> 'open') or
     (e.scheduled_end_at is not null and e.scheduled_end_at <= now()) then
    raise exception 'EXAM_NOT_OPEN' using hint = 'This exam is not accepting students right now.';
  end if;
  return jsonb_build_object('registration_required', true, 'code', e.code);
end;
$$;
revoke execute on function public.student_join(text,text) from public, anon, authenticated;
grant execute on function public.student_join(text,text) to anon, authenticated;
notify pgrst, 'reload schema';
