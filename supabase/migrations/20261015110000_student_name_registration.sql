-- Separate names for new registrations; retain student_name for all existing
-- teacher screens, exports, saved attempts, and older deployed clients.
alter table public.exam_sessions
  add column if not exists student_first_name text,
  add column if not exists student_last_name text;

-- Do not guess how to split existing names: compound given/family names are
-- ambiguous. A successful legacy-name match can populate the separate fields.
create or replace function public.student_join_identity(
  p_code text, p_email text, p_name text, p_first_name text, p_last_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  e public.exams;
  s public.exam_sessions;
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_name text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
  v_first text := btrim(regexp_replace(coalesce(p_first_name, ''), '\s+', ' ', 'g'));
  v_last text := btrim(regexp_replace(coalesce(p_last_name, ''), '\s+', ' ', 'g'));
  v_parts boolean := p_first_name is not null or p_last_name is not null;
  v_token uuid;
begin
  select * into e from public.exams where code = upper(btrim(coalesce(p_code, '')));
  if e.id is null then raise exception 'EXAM_NOT_FOUND' using hint = 'Check the exam code with your teacher.'; end if;
  if v_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'INVALID_EMAIL' using hint = 'Enter a valid email address.'; end if;
  if v_parts then
    if char_length(v_first) not between 1 and 60 then raise exception 'INVALID_NAME' using hint = 'Enter your first name (up to 60 characters).'; end if;
    if char_length(v_last) not between 1 and 60 then raise exception 'INVALID_NAME' using hint = 'Enter your last name (up to 60 characters).'; end if;
    v_name := v_first || ' ' || v_last;
  end if;
  if char_length(v_name) not between 1 and 120 then raise exception 'INVALID_NAME' using hint = 'Keep your combined name within 120 characters.'; end if;

  -- Serialize join requests within this exam. This prevents simultaneous requests
  -- with different emails from both passing the name check and creating entries.
  -- An advisory lock avoids locking the exam row used by other teacher actions.
  perform pg_advisory_xact_lock(hashtextextended('student_join:' || e.id::text, 0));
  select * into s from public.exam_sessions where exam_id = e.id and student_email = v_email;
  if s.id is not null then
    if v_parts and s.student_first_name is not null and s.student_last_name is not null then
      if public.normalize_answer(s.student_first_name) <> public.normalize_answer(v_first)
        or public.normalize_answer(s.student_last_name) <> public.normalize_answer(v_last) then
        raise exception 'NAME_MISMATCH' using hint = 'Enter the same first and last name you used when you first joined this exam.';
      end if;
    elsif public.normalize_answer(s.student_name) <> public.normalize_answer(v_name) then
      raise exception 'NAME_MISMATCH' using hint = 'Enter the same name you used when you first joined this exam.';
    end if;
    select token into v_token from public.session_tokens where session_id = s.id;
    if v_token is null then raise exception 'INVALID_TOKEN' using hint = 'Your exam access could not be restored. Ask your teacher for help.'; end if;
    if v_parts and s.student_first_name is null and s.student_last_name is null then
      update public.exam_sessions set student_first_name = v_first, student_last_name = v_last where id = s.id;
    end if;
    -- Preserve approval/rejection, active or completed status, answers, violations,
    -- deadlines, retakes, original display name, and the token on every device.
    return jsonb_build_object('token', v_token, 'code', e.code);
  end if;

  -- A matching name under another email blocks a new entry; names alone never
  -- grant access to someone else's session. Existing duplicates are not merged.
  if exists (
    select 1 from public.exam_sessions candidate where candidate.exam_id = e.id and (
      (v_parts and candidate.student_first_name is not null and candidate.student_last_name is not null
        and public.normalize_answer(candidate.student_first_name) = public.normalize_answer(v_first)
        and public.normalize_answer(candidate.student_last_name) = public.normalize_answer(v_last))
      -- Also prevent moving a word between the two fields to register the same
      -- combined display name under a new email (e.g. Juan / Dela Cruz).
      or public.normalize_answer(candidate.student_name) = public.normalize_answer(v_name)
    )
  ) then
    raise exception 'DUPLICATE_STUDENT' using hint = 'This name is already registered for this exam. Use the original email to continue, or ask your teacher for help.';
  end if;

  if e.status = 'closed' or (e.scheduled_end_at is null and e.status <> 'open') or
     (e.scheduled_end_at is not null and e.scheduled_end_at <= now()) then
    raise exception 'EXAM_NOT_OPEN' using hint = 'This exam is not accepting students right now.';
  end if;
  insert into public.exam_sessions(exam_id, student_email, student_name, student_first_name, student_last_name)
  values(e.id, v_email, v_name, case when v_parts then v_first end, case when v_parts then v_last end)
  returning * into s;
  insert into public.session_tokens(session_id) values(s.id) returning token into v_token;
  insert into public.session_events(session_id, exam_id, type) values(s.id, e.id, 'join_requested');
  return jsonb_build_object('token', v_token, 'code', e.code);
end;
$$;

-- New form: PostgREST resolves this overload by its separate parameter names.
create or replace function public.student_join(p_code text, p_email text, p_first_name text, p_last_name text)
returns jsonb language sql security definer set search_path = '' as $$
  select public.student_join_identity(p_code, p_email, null, p_first_name, p_last_name);
$$;

-- Older online clients retain their existing three-argument contract while also
-- receiving the database duplicate-name check during the rollout.
create or replace function public.student_join(p_code text, p_email text, p_name text)
returns jsonb language sql security definer set search_path = '' as $$
  select public.student_join_identity(p_code, p_email, p_name, null, null);
$$;

revoke execute on function public.student_join_identity(text,text,text,text,text),
  public.student_join(text,text,text,text), public.student_join(text,text,text) from public, anon, authenticated;
grant execute on function public.student_join(text,text,text,text), public.student_join(text,text,text) to anon, authenticated;
notify pgrst, 'reload schema';
