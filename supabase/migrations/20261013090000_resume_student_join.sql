-- Rejoining recovers the existing attempt using the exam code, email and full name.
-- These details now grant access to the attempt; teacher approval is preserved.
create or replace function public.student_join(p_code text, p_email text, p_name text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  e public.exams;
  s public.exam_sessions;
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_name text := btrim(coalesce(p_name, ''));
  v_session_id uuid;
  v_token uuid;
begin
  select * into e from public.exams where code = upper(btrim(coalesce(p_code, '')));
  if e.id is null then raise exception 'EXAM_NOT_FOUND' using hint = 'Check the exam code with your teacher.'; end if;
  if v_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'INVALID_EMAIL' using hint = 'Enter a valid email address.'; end if;
  if char_length(v_name) not between 1 and 120 then raise exception 'INVALID_NAME' using hint = 'Enter your full name.'; end if;

  select * into s from public.exam_sessions where exam_id = e.id and student_email = v_email;
  if s.id is null then
    if e.status = 'closed' or (e.scheduled_end_at is null and e.status <> 'open') or
       (e.scheduled_end_at is not null and e.scheduled_end_at <= now()) then
      raise exception 'EXAM_NOT_OPEN' using hint = 'This exam is not accepting students right now.';
    end if;
    -- Concurrent requests for the same email must also resume one entry.
    insert into public.exam_sessions (exam_id, student_email, student_name)
    values (e.id, v_email, v_name)
    on conflict (exam_id, student_email) do nothing
    returning id into v_session_id;
    if v_session_id is not null then
      insert into public.session_tokens (session_id) values (v_session_id) returning token into v_token;
      insert into public.session_events (session_id, exam_id, type) values (v_session_id, e.id, 'join_requested');
      return jsonb_build_object('token', v_token, 'code', e.code);
    end if;
    select * into s from public.exam_sessions where exam_id = e.id and student_email = v_email;
  end if;

  if lower(regexp_replace(btrim(s.student_name), '\s+', ' ', 'g')) <>
     lower(regexp_replace(v_name, '\s+', ' ', 'g')) then
    raise exception 'NAME_MISMATCH' using hint = 'Enter the same full name you used when you first joined this exam.';
  end if;
  -- Keep the original token valid on other devices, and preserve status, answers,
  -- deadline, violations and teacher decisions. The exam room handles routing.
  select token into v_token from public.session_tokens where session_id = s.id;
  if v_token is null then
    raise exception 'INVALID_TOKEN' using hint = 'Your exam access could not be restored. Ask your teacher for help.';
  end if;
  return jsonb_build_object('token', v_token, 'code', e.code);
end;
$$;
