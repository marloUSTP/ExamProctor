-- Let students review their own answers and the answer key after submission by default.
-- Teachers can still turn this off at any time in the exam's Settings.
alter table public.exams
  alter column show_correct_answers set default true;

update public.exams
set show_correct_answers = true,
    updated_at = now()
where show_correct_answers = false;
