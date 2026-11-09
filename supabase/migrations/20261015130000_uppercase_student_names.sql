-- Normalize newly registered names on the server, including older clients.
-- Existing display names and exam attempts are not rewritten.
create or replace function public.normalize_student_registration_names()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.student_first_name is not null then
    new.student_first_name := upper(btrim(regexp_replace(new.student_first_name, '\s+', ' ', 'g')));
  end if;
  if new.student_last_name is not null then
    new.student_last_name := upper(btrim(regexp_replace(new.student_last_name, '\s+', ' ', 'g')));
  end if;
  if tg_op = 'INSERT' then
    new.student_name := upper(btrim(regexp_replace(new.student_name, '\s+', ' ', 'g')));
  end if;
  return new;
end;
$$;
drop trigger if exists normalize_student_registration_names on public.exam_sessions;
create trigger normalize_student_registration_names
  before insert or update of student_first_name, student_last_name on public.exam_sessions
  for each row execute function public.normalize_student_registration_names();
revoke execute on function public.normalize_student_registration_names() from public, anon, authenticated;
notify pgrst, 'reload schema';
