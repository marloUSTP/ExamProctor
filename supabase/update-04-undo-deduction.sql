-- =====================================================================
-- Update 04 — "Undo" for point deductions
--
-- Only for databases that already ran an older schema.sql (+ update-01 … 03).
-- (A fresh setup just runs schema.sql, which already includes this.)
-- Supabase Dashboard → SQL Editor → New query → paste → Run. Safe to run twice.
-- =====================================================================

-- New activity-log entry type
alter table public.session_events drop constraint if exists session_events_type_check;
alter table public.session_events add constraint session_events_type_check check (type in (
  'join_requested', 'approved', 'rejected', 'started',
  'left', 'returned', 'idle', 'idle_ended',
  'blocked_action', 'fullscreen_exit',
  'submitted', 'auto_submitted',
  'retake_allowed', 'points_deducted', 'deduction_undone'
));

-- Gives back the points of one earlier deduction (e  .g. deducted by mistake).
-- Only deductions from the student's current attempt can be undone, once each.
create or replace function public.teacher_undo_deduction(p_event_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  ev public.session_events;
  s public.exam_sessions;
begin
  select * into ev from public.session_events where id = p_event_id and type = 'points_deducted';
  if ev.id is null or not public.owns_session(ev.session_id) then
    raise exception 'DEDUCTION_NOT_FOUND' using hint = 'That deduction no longer exists.';
  end if;
  select * into s from public.exam_sessions where id = ev.session_id for update;
  if exists (
    select 1 from public.session_events
    where session_id = ev.session_id and type = 'deduction_undone' and detail = ev.id::text
  ) then
    raise exception 'ALREADY_UNDONE' using hint = 'That deduction was already undone.';
  end if;
  if exists (
    select 1 from public.session_events
    where session_id = ev.session_id and type = 'retake_allowed' and id > ev.id
  ) then
    raise exception 'OLD_ATTEMPT' using hint = 'That deduction was for an earlier attempt, which was already reset.';
  end if;

  update public.exam_sessions set deduction = greatest(0, deduction - ev.points) where id = s.id;

  insert into public.session_events (session_id, exam_id, type, points, detail)
  values (s.id, s.exam_id, 'deduction_undone', ev.points, ev.id::text);

  if s.status in ('submitted', 'auto_submitted') then
    perform public.grade_session(s.id);
  end if;
end;
$$;

revoke execute on function public.teacher_undo_deduction(bigint) from public, anon;
grant execute on function public.teacher_undo_deduction(bigint) to authenticated;
