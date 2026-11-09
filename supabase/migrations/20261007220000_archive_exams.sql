alter table public.exams
  add column is_archived boolean not null default false;

create index exams_teacher_archived_created_idx
  on public.exams (teacher_id, is_archived, created_at desc);

create or replace function public.teacher_archive_exam(p_exam_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.owns_exam(p_exam_id) then
    raise exception 'FORBIDDEN';
  end if;

  -- Close the exam first so active students are submitted before it is hidden.
  perform public.teacher_close_exam(p_exam_id);
  update public.exams
  set is_archived = true, status = 'closed', updated_at = now()
  where id = p_exam_id;
end;
$$;

create or replace function public.teacher_restore_exam(p_exam_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.owns_exam(p_exam_id) then
    raise exception 'FORBIDDEN';
  end if;

  update public.exams
  set is_archived = false, status = 'closed', updated_at = now()
  where id = p_exam_id;
end;
$$;

revoke execute on function public.teacher_archive_exam(uuid) from public, anon;
revoke execute on function public.teacher_restore_exam(uuid) from public, anon;
grant execute on function public.teacher_archive_exam(uuid) to authenticated;
grant execute on function public.teacher_restore_exam(uuid) to authenticated;
