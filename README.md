# Exam Proctor

Online exams with live proctoring, built with Next.js 16, Supabase and shadcn/ui.

- **Teachers** sign in at `/teacher/login` with the built-in account (no sign-up), create exams with an answer key, approve students, and watch a live dashboard.
- **Students** start with exam code and email — no account. Existing students continue immediately; new students
  then enter first and last name to request teacher approval. The email lookup itself creates no entry.
- Returning students need only the same exam code and email, even on a new browser or device. Approved students
  see the start screen, pending students wait for approval, and active attempts resume with saved answers.
  Rejected and completed attempts keep their status. Before a new registration, names are checked ignoring case
  and repeated spaces. A matching name under a different email cannot create a second entry in the same exam;
  use the original email or contact the teacher.
- Pending answers are saved on the current device immediately and retried until the server accepts them. Reopening
  the same attempt restores local drafts after reconnecting; a retake starts fresh. The save indicator distinguishes
  device storage from a server save. Recovery requires browser storage and the same browser/device; finished attempts
  clear their drafts, and local recovery does not extend an exam deadline.
- Scheduled exams show a countdown that advances every second between server checks.
- Leaving the exam window (Alt+Tab, switching tabs, minimizing) counts as a **violation** and notifies the teacher.
  At the teacher's limit (default 5) the exam is **auto-saved and submitted**; the final warning comes one step earlier (default 4).
- **Idle** students get "Are you still there?" and the teacher is notified (a violation only if the teacher enables it).
- **Right-click, copy, paste** and common shortcuts are blocked and logged, never counted as violations.
- **Questions and multiple-choice options are shuffled** per student (teacher can turn either off).
- Teachers can **paste a whole list of questions** (numbered questions, lettered choices, optional `Answer: b` lines or an
  answer key) and the fields fill in automatically.
- Teachers can **import questions from `.docx` or text-based PDF files**. The file is read in the browser, then parsed
  into a preview for review before adding; scanned PDFs and older `.doc` files aren’t supported.
- Teachers can allow a **teacher-approved retake** for a valid exceptional case, and **duplicate an exam** with its
  questions and answer key (⋯ menu on the exam list or exam page).
- Teachers can **export the test paper to Word** (⋯ menu → Export to Word): questions stay in order, multiple-choice
  options are shuffled on every export, and the answer key is on the last page. The letterhead, name table and fonts
  come from `public/templates/exam-paper.docx`; edit it in Word to change them, keeping the `{{EXAM_CONTENT}}` line.
- Teachers can **deduct points** from a student caught cheating (⋯ menu on the live monitor), during or after the exam,
  or from the results tab, with an optional reason, and **undo** a deduction made by mistake. It shows in the activity
  log (teacher only); students just see the lower score. The score never goes below 0.
- After submitting, each student gets a **result code** to check their score later from any device at `/results`.
- Exams are **auto-graded** (multiple choice, true/false, identification). Teachers can fix grades by hand, re-grade,
  release scores later, and export CSV.
- Essays support **Gemini/Groq rubric suggestions and teacher-approved partial credit**. Teachers upload/paste a rubric,
  extract or manually enter criteria, then request suggested scores in Results. Essay totals remain pending until
  every essay in that submission is approved. Released results show a **partial score** from auto-graded answers and
  approved essays while other essays await grading. Ungraded essays display **Awaiting grading**, not zero.
  Approved breakdowns and feedback appear with released results. The score lookup updates automatically.
- The Results tab includes an **AI score approval checklist**. Search students or questions, expand the response,
  rubric criteria, AI explanations and evidence, then select the scores to approve together. Select all ready in
  the current filtered view includes every matching page. Review and edit opens the existing individual scorer.
  Approvals run one at a time and can stop after the current score. Already approved, outdated and invalid drafts
  cannot be selected; changed inputs are checked again by the database before each approval. Login or connection
  failures stop remaining approvals without automatic retries. Refresh the checklist before retrying flagged items.
  This feature uses the existing rubric approval database functions and requires no additional migration.
- The system never records which app or website a student opened — only that they left the exam.

## Setup

1. **Database** — in the Supabase dashboard open **SQL Editor → New query**, paste all of
   [`supabase/schema.sql`](supabase/schema.sql) and click **Run**.
   - Already ran an older `schema.sql`? Run the `supabase/update-*.sql` files you haven't run yet instead, in order.
2. **Teacher account** — after the schema is applied, add these values to `.env.local` (project root or `supabase/.env.local`):
   ```
   SUPABASE_SECRET_KEY=...         # Supabase project Settings → API Keys; keep this server-side
   TEACHER_PASSWORD=...            # choose a strong password
   # TEACHER_USERNAME=p3lep404     # optional; this is the default
   ```
   Then run `npm run seed:teacher`. It creates or enables the teacher in Supabase Auth and adds the teacher
   record. The default login username is `p3lep404`; the password is the value you set in `.env.local`.
3. **Turn off sign-ups** — **Authentication → Sign In / Providers → Allow new users to sign up: off**. There is no
   sign-up page, and only accounts in the `teachers` table can manage exams anyway.
4. **Environment** — `.env.local` needs:
   ```
   NEXT_PUBLIC_SUPABASE_URL=...
   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=...
   SUPABASE_SECRET_KEY=...        # needed only to seed a teacher; never prefix with NEXT_PUBLIC_
   TEACHER_PASSWORD=...           # needed only to seed a teacher
   ```
5. `npm install` then `npm run dev`.
   - Students: http://localhost:3000
   - Teacher: http://localhost:3000/teacher/login (not linked from the home page)

## How it fits together

The teacher workspace uses a sliding tab indicator and short panel reveals inspired by the
[BrewedOps desktop motion patterns](https://brewedops.cloud/motionlibrary/#nav). Student lists, results, and
answer review show content-shaped loading placeholders. Existing confirmation dialogs and save-success toasts
are retained. The tab indicator, panel reveals, skeleton shimmer, and dialogs respect reduced-motion preferences.
These effects use the existing React/CSS stack and add no animation package or grading/database behavior.

Run `npm run test:student` for isolated checks of draft recovery, save retries, concurrent edits, and the countdown.
These checks use simulated storage and network responses and do not connect to the online database.

| Piece | Where |
| --- | --- |
| Tables, security rules, grading, violation and auto-submit logic | `supabase/schema.sql` |
| Alt+Tab / idle / blocked-action detection in the browser | `src/hooks/use-proctoring.ts` |
| Student pages (join, waiting room, exam, result) | `src/app/join`, `src/app/exam/[code]`, `src/components/student` |
| Teacher login and dashboard (monitor, questions, settings, results) | `src/app/teacher`, `src/components/teacher` |
| Live updates + teacher notifications (Supabase Realtime) | `src/hooks/use-exam-live.ts` |

Students never get table access: every student action is a database function that checks their secret session
token, so the answer key and other students' data can't be read from the browser. The violation count and
auto-submit are decided in the database, so they can't be bypassed by editing the page.

The join function issues the existing token when the exam code and email match. These details therefore allow
access to that student's attempt without email verification. Older full-name clients remain compatible. Existing deployments must apply
`supabase/migrations/20261013090000_resume_student_join.sql` (with `npx supabase db push`) for this recovery flow.

For separate first/last name registration and duplicate checks, apply
[`supabase/migrations/20261015110000_student_name_registration.sql`](supabase/migrations/20261015110000_student_name_registration.sql)
before deploying the updated join form. The old full-name RPC remains available for older clients and receives
the duplicate check too. Existing names are not guessed, split, merged, or deleted: a matching email and combined
name resumes the original attempt, and the separate fields are saved on that successful match. Compound first
and last names, accents, apostrophes and hyphens are accepted. Two students with the same first and last name
need the teacher to resolve the name collision; the system does not grant session access from names alone.

Also apply [`supabase/migrations/20261015120000_email_only_exam_continue.sql`](supabase/migrations/20261015120000_email_only_exam_continue.sql)
to enable the two-step join form. Changing the exam code or email resets the new-student step. Existing students
do not have to re-enter their names. The small form reveal and press animations respect reduced-motion settings
and use CSS, with no added animation dependency. Run `npm run test:registration` for isolated database checks.

New first and last names display and save in uppercase. Apply
[`supabase/migrations/20261015130000_uppercase_student_names.sql`](supabase/migrations/20261015130000_uppercase_student_names.sql)
for server-side enforcement, including older clients. Existing display names and attempts are preserved;
duplicate matching still ignores case and spacing.

## Essay checking without AI

Rule-based checking needs no Google key or AI billing. In **Questions & answer key**, enter an essay's rubric
criteria, scoring descriptions and maximum points. For each factual criterion, choose an **Automatic checking**
policy: all concepts for full points, any concept for full points, or equal partial points per concept. Enter one
concept per line; use `|` for accepted synonyms on the same line (for example `water | H2O`). Keep subjective
criteria on **Manual review only**. Save the questions before checking submissions. Uploaded documents remain
reference text; rule checking does not automatically infer scoring rules from prose rubrics.

After submission, open **Results → View answers → Check with rules**. The checker matches whole words and
phrases, ignoring case and punctuation, and counts each concept once. Equal partial scores round down to 0.01;
every result is capped at the criterion maximum. It fills a draft with points, matches, missing concepts and
verbatim evidence. Criteria without rules remain unscored. Drafts run in the teacher's browser, send no requests
to Google, and are saved only with **Approve rubric score**. Closing the dialog discards an unapproved rule draft.

Keyword matches do not establish understanding or correctness: an incorrect or negated statement can still match.
Teachers must review all suggestions, assess subjective criteria, and explicitly approve the final score. Changing
concept rules invalidates earlier approvals just like changing a rubric. Existing rubric approval database setup
is required; there is no additional migration for concept rules. Run `npm run test:rules` for offline checks.

## Rubric grading with Gemini and Groq

If results are released but students cannot see their points while essays await approval, apply
[`supabase/migrations/20261029090000_release_partial_student_scores.sql`](supabase/migrations/20261029090000_release_partial_student_scores.sql)
in the connected project's Supabase SQL editor after installing rubric grading. Deploy the updated app to show
partial-score labels and pending essay markers. The migration is safe to rerun; it preserves grades, teacher
approvals, release settings, and hiding controls. Final stored totals still require approval of every essay.

If `student_state` returns `42703: record "e" has no field "results_hidden"`, apply
[`supabase/migrations/20261015090000_repair_results_hidden.sql`](supabase/migrations/20261015090000_repair_results_hidden.sql)
in the connected project's Supabase SQL editor, then refresh the student page. The repair only adds the missing
result-visibility column and reloads the API schema; it preserves existing rows and visibility settings.

For an existing database with the previous migrations applied, run
[`supabase/migrations/20261014090000_rubric_essay_grading.sql`](supabase/migrations/20261014090000_rubric_essay_grading.sql)
in the Supabase SQL editor before using this version. The standalone `schema.sql` also includes the grading setup
for a new database. Only apply this migration if rubric grading has not already been installed; it creates tables
and triggers and is not intended to be run twice.

Then apply [`supabase/migrations/20261018100000_gemini_teacher_requests.sql`](supabase/migrations/20261018100000_gemini_teacher_requests.sql)
in the Supabase SQL editor. It adds persistent request limits and a per-teacher in-flight guard for Vercel.
Do not run the whole `schema.sql` against an existing database.

Set these **server-only** environment variables in `.env.local` and in the Vercel project's environment settings.
Either key works alone. Set both keys to enable a backup; Gemini is the default primary unless changed:

```dotenv
GEMINI_API_KEY=your-google-ai-studio-key
GROQ_API_KEY=your-groq-key
AI_PRIMARY_PROVIDER=gemini
AI_PROVIDER_FALLBACK=true
GEMINI_GRADING_MODEL=auto
GROQ_GRADING_MODEL=auto
```

Create a Groq key in the [Groq console](https://console.groq.com/keys). This configuration tries Gemini first and
uses Groq as its backup. Use `AI_PRIMARY_PROVIDER=groq` to reverse that order. `AI_PROVIDER_FALLBACK=false` restricts calls to the selected primary, including when its key is
missing. To keep Google out of a Groq-only demo, omit its key or disable fallback with Groq selected. No SDK or
additional database migration is required. See [`.env.example`](.env.example) for placeholder settings.

Models default to `auto` when the model variables are omitted. Auto selection queries the provider's authenticated
model catalog, excludes identified speech/image/embedding/moderation/tool-system and preview models, prefers
stable Gemini Flash IDs in descending numeric order, and ranks Groq text candidates by creation timestamp with
numeric ID ordering as a tie-breaker. Catalogs do not uniformly expose release dates or JSON capabilities, so this
is a current compatible-model selection policy, not a guarantee of the globally newest or highest-quality model.
Groq uses JSON object mode plus the same local schema, rubric, point-bound and evidence validation as Gemini.
See [Groq models](https://console.groq.com/docs/models), [Groq JSON output](https://console.groq.com/docs/structured-outputs),
and [Gemini model discovery](https://ai.google.dev/api/models) for the underlying APIs.

You may pin an explicit model ID. If a selected/pinned model returns a missing, decommissioned or recognized
model-incompatibility error, the app refreshes discovery and tries one other candidate from that provider.
Successful selections are cached for five minutes per credential and requested model in each server instance;
retirement errors invalidate the cached choice immediately. Auto mode checks the catalog again after expiration.
Provider model retirement is detected from API failures, not by scraping lifecycle announcements. Preview models
can be pinned explicitly if needed. Stored suggestions show the actual provider and model (for example
`groq:provider/model-name`); existing Gemini suggestions remain readable and matching saved suggestions are reused.

Restart development or redeploy Vercel after changing environment variables. Never use a `NEXT_PUBLIC_` prefix for
the AI key. Replace any key shared in chat. `.env.local` is ignored; Vercel needs its own environment setting.
A key can list models even when its project cannot generate content. If generation returns Google HTTP 403
with "Your project has been denied access", use a key from a project with generation enabled or contact Google
support. If Supabase database administration returns HTTP 403, a project owner must apply the migration through
the SQL editor or restore the CLI account's project access.

1. In **Questions & answer key**, add an Essay and set its maximum points.
2. Upload a `.docx`, selectable-text PDF, or `.txt` rubric, or paste its text. The original file stays in the browser;
   extracted text is saved as reference. Choose **Extract criteria with AI**, review the criterion descriptions and
   maximum points, then save the questions. You can also enter criteria manually. Extraction preserves the document's
   point limits rather than silently rescaling them; totals must match the question's maximum before saving.
3. After a student submits, open **Results → View answers → Suggest scores with AI** for each rubric-backed essay.
   Review the proposed partial points, explanations, and answer quotations. Edit them as needed, then choose
   **Approve rubric score**. Manual scoring remains available without AI or a working key, including zero scores.
4. Pending essays do not count as a final zero. A student's total stays hidden until every essay is approved, even
   after the exam closes or the teacher releases results. Approved grades follow the existing release/hide controls.
5. Regrading preserves approved points. Changing an essay's prompt, rubric, or point limit requires fresh approval.
   Duplicating an exam copies its rubric; retakes remove the previous attempt's answers and suggestions.

AI calls run on the Next.js server, so they work with Vercel without a local model or computer running continuously.
Only signed-in teachers can request them; grading uses the owner's saved question, rubric and submitted answer.
Student names, emails and proctoring events are not added to the prompt. Document/answer text can itself contain
personal information, so review what you send. AI buttons disclose that text is sent to configured Google/Groq
providers, including a backup when enabled. Both providers' billing, quotas and data terms apply; configuring this
feature does not enable billing or guarantee free API access. Offline tests do not call either provider.

Requests time out after 45 seconds, allow one active request per teacher, and are limited to 10 starts per minute
per teacher across server instances. Failures release the lease; crashed requests expire after 90 seconds.
Matching saved suggestions are reused without another provider call. A request makes at most two generation
attempts and two discovery lookups per configured provider. Each discovery reads up to three Gemini catalog
pages (one for Groq), within a shared 45-second deadline. When both providers are configured, the first provider has at most 21 seconds so the backup
has time to run. Model catalog calls have an additional five-second limit per page. Access/key/billing errors,
rate limits, connection failures and provider server errors can advance to the backup without retrying the same
failed model. Generic bad requests, safety refusals, malformed/schema-invalid output, or invalid scores/evidence
stop without further generation. No AI result changes scores until explicit teacher approval. Input snapshots and attempt checks
reject suggestions if the rubric, question or submission changes during generation. Validate grading quality
against a sample of teacher-marked essays before relying on suggestions across a class.

For a class, use **Results → Generate pending essay suggestions**. Select essay questions with saved, valid rubrics,
then click **Generate pending essay suggestions** to prepare the list and start automatically.
The teacher-started queue works student by student, one essay per request, with at least seven seconds between starts.
Approved answers and matching saved drafts are skipped. Scores stay pending until the teacher reviews and approves
each rubric score through **Review [student]** or **View answers**; the queue never approves or releases scores.

**Pause** lets the current request finish and save before stopping. Connection, timeout and server errors retry automatically
after 15 seconds; rate limits start with a 60-second cooldown. Repeated failures increase the delay up to five minutes.
Sign-in, permission and other permanent request errors pause for your attention. Invalid individual output is marked failed;
stale attempts/questions are skipped. Inspect these items and refresh the list after correcting them.
You can switch browser windows or workspace tabs while the queue runs. Keep the exam page open: navigating away or closing
the page stops further requests, although an already submitted server request may still save its draft. Reopening and generating
again finds saved suggestions without regenerating them. Sleeping/background tabs can delay requests; the queue continues when
the browser wakes. This is a browser queue, not a server worker. New submissions require a refreshed list. No new database migration is needed.

Downsides: a class consumes more provider allowance and may exceed a free quota; quota exhaustion can keep the queue retrying until paused; the same rubric
misinterpretation can affect multiple essays; Gemini/Groq fallback may produce inconsistent judgments. Review a sample first
and inspect each student's evidence and score. The feature does not enable billing or bypass provider restrictions.

Failure messages name the attempted providers in order and include each safe provider error. If a backup was
skipped, the message distinguishes a missing server API key from disabled fallback. Environment variables in
`.env.local` do not configure Vercel Production; save the keys and provider settings for that environment and
redeploy. Use `auto` for both grading-model variables; `groq-1.0.0` is not a hosted Groq text model ID.

Run `npm run test:ai` for offline Gemini/Groq discovery, failover, response validation, API auth, ownership, caching and failure tests.
Run `npm run test:essay-queue` for offline selection, saved-draft reuse, sequential dispatch, pacing, pause/resume and pagination tests.
Run `npm run test:grading` for isolated PostgreSQL tests of grading, result visibility, stale suggestions, retakes,
request limits and ownership controls. These tests use PGlite and do not connect to the online database. If editing the grading
migration, run `node scripts/sync-grading-schema.mjs` to refresh its student-result function and the standalone setup.
#   E x a m P r o c t o r  
 