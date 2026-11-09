-- Repair older databases whose result-state function already reads this field.
-- Preserve an existing column and its values when the migration is rerun.
alter table public.exams
  add column if not exists results_hidden boolean not null default false;

notify pgrst, 'reload schema';
