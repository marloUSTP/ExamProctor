-- Persistent quota and in-flight guard work across Vercel instances.
-- Requires 20261014090000_rubric_essay_grading.sql first.
create table public.teacher_ai_limits (
  teacher_id uuid primary key references auth.users(id) on delete cascade,
  window_start timestamptz not null default clock_timestamp(),
  requests integer not null default 0,
  lease uuid,
  lease_until timestamptz
);
alter table public.teacher_ai_limits enable row level security;
revoke all on public.teacher_ai_limits from anon, authenticated;

create or replace function public.teacher_claim_ai_request()
returns uuid language plpgsql security definer set search_path = '' as $$
declare t timestamptz := clock_timestamp(); token uuid := gen_random_uuid(); result uuid;
begin
  if not coalesce(public.is_teacher(), false) then raise exception 'FORBIDDEN'; end if;
  insert into public.teacher_ai_limits(teacher_id) values(auth.uid()) on conflict do nothing;
  update public.teacher_ai_limits set
    requests = case when window_start <= t - interval '1 minute' then 1 else requests + 1 end,
    window_start = case when window_start <= t - interval '1 minute' then t else window_start end,
    lease = token, lease_until = t + interval '90 seconds'
  where teacher_id = auth.uid()
    and (lease_until is null or lease_until <= t)
    and (window_start <= t - interval '1 minute' or requests < 10)
  returning lease into result;
  if result is null then raise exception 'AI_RATE_LIMIT'; end if;
  return result;
end;
$$;

create or replace function public.teacher_release_ai_request(p_lease uuid)
returns void language sql security definer set search_path = '' as $$
  update public.teacher_ai_limits set lease = null, lease_until = null
  where teacher_id = auth.uid() and lease = p_lease;
$$;
revoke all on function public.teacher_claim_ai_request() from public, anon;
revoke all on function public.teacher_release_ai_request(uuid) from public, anon;
grant execute on function public.teacher_claim_ai_request() to authenticated;
grant execute on function public.teacher_release_ai_request(uuid) to authenticated;
notify pgrst, 'reload schema';
