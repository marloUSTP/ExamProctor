-- Checks (and fixes) Supabase Realtime for the teacher's live dashboard.
-- Supabase Dashboard → SQL Editor → New query → paste → Run. Safe to run any number of times.

do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'exam_sessions') then
    alter publication supabase_realtime add table public.exam_sessions;
  end if;
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'session_events') then
    alter publication supabase_realtime add table public.session_events;
  end if;
end
$$;

-- Should list exam_sessions and session_events.
select tablename from pg_publication_tables
where pubname = 'supabase_realtime' and schemaname = 'public'
order by tablename;
