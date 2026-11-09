export type ExamStatus = "draft" | "open" | "closed"
export type QuestionType = "multiple_choice" | "true_false" | "identification" | "essay"
export type SessionStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "in_progress"
  | "submitted"
  | "auto_submitted"
export type Activity = "active" | "away" | "idle"

export type EventType =
  | "join_requested"
  | "approved"
  | "rejected"
  | "started"
  | "left"
  | "returned"
  | "idle"
  | "idle_ended"
  | "blocked_action"
  | "screenshot_attempt"
  | "fullscreen_exit"
  | "submitted"
  | "auto_submitted"
  | "retake_allowed"
  | "points_deducted"
  | "deduction_undone"

export type BlockedAction = "right_click" | "copy" | "cut" | "paste" | "shortcut"

export interface Exam {
  id: string
  teacher_id: string
  title: string
  instructions: string
  code: string
  status: ExamStatus
  is_archived: boolean
  scheduled_start_at: string | null
  scheduled_end_at: string | null
  max_violations: number
  warn_at: number
  idle_limit_seconds: number
  idle_counts_as_violation: boolean
  block_copy_paste: boolean
  shuffle_questions: boolean
  shuffle_choices: boolean
  show_score: "immediately" | "after_release"
  results_released: boolean
  results_hidden: boolean
  show_correct_answers: boolean
  created_at: string
  updated_at: string
}

export interface Question {
  id: string
  exam_id: string
  position: number
  type: QuestionType
  prompt: string
  choices: string[]
  correct_answers: string[]
  points: number
  rubric?: Rubric | null
  rubric_source_text?: string
}

export interface RubricCriterion {
  id: string
  name: string
  description: string
  max_points: number
  checking_rule?: RubricCheckingRule
}

export interface RubricCheckingRule {
  mode: "all" | "any" | "proportional"
  /** One concept per line; separate accepted synonyms with |. */
  concepts: string
}

export interface Rubric {
  criteria: RubricCriterion[]
}

export interface CriterionGrade {
  criterion_id: string
  points: number
  reason: string
  evidence: string
}

export interface EssaySuggestion {
  id: string
  session_id: string
  question_id: string
  attempt: number
  answer_snapshot: string
  question_snapshot: { prompt: string; points: number; rubric: Rubric }
  grading: { criteria: CriterionGrade[]; feedback: string }
  model: string
  created_at: string
  approved_at: string | null
  approved_by: string | null
  final_grading: { criteria: CriterionGrade[]; feedback: string } | null
}

export interface ExamSession {
  id: string
  exam_id: string
  student_email: string
  student_name: string
  status: SessionStatus
  activity: Activity
  activity_since: string
  violation_count: number
  /** 1 for the first try; 2, 3, … after the teacher allows a retake */
  attempt: number
  last_seen_at: string
  started_at: string | null
  submitted_at: string | null
  score: number | null
  max_score: number | null
  /** Points the teacher took off (e.g. caught cheating); already subtracted from `score`. */
  deduction: number
  result_code: string | null
  created_at: string
}

export interface SessionEvent {
  id: number
  session_id: string
  exam_id: string
  type: EventType
  counted: boolean
  violation_number: number | null
  duration_seconds: number | null
  /** Points taken off / given back, for "points_deducted" / "deduction_undone" */
  points: number | null
  detail: string | null
  created_at: string
}

export interface Answer {
  session_id: string
  question_id: string
  answer: string
  is_correct: boolean | null
  points_awarded: number | null
  overridden: boolean
  manual_points?: number | null
  approval_snapshot?: { prompt: string; points: number; rubric: Rubric | null } | null
  graded_at?: string | null
  graded_by?: string | null
  rubric_grading?: { criteria: CriterionGrade[]; feedback: string } | null
}

/* ---------- Shapes returned by the student_* database functions ---------- */

export interface StudentState {
  session: {
    student_name: string
    student_email: string
    status: SessionStatus
    activity: Activity
    violation_count: number
    started_at: string | null
    submitted_at: string | null
    /** Only set once submitted — used for "Check my score". */
    result_code: string | null
    auto_submit_reason?: string | null
    grading_pending?: boolean
  }
  exam: {
    code: string
    title: string
    instructions: string
    status: ExamStatus
    max_violations: number
    warn_at: number
    idle_limit_seconds: number
    idle_counts_as_violation: boolean
    block_copy_paste: boolean
    question_count: number
    scheduled_start_at: string | null
    scheduled_end_at: string | null
    server_now: string
  }
  review: ReviewItem[] | null
  result: {
    score: number
    max_score: number
    is_partial?: boolean
    pending_questions?: number
  } | null
}

export interface ReviewItem {
  question_id: string
  prompt: string
  type: QuestionType
  choices: string[]
  choice_order?: number[]
  your_answer: string | null
  correct_answers?: string[]
  points?: number
  points_awarded?: number | null
  grading_pending?: boolean
  rubric_feedback?: string | null
  rubric_scores?: { name: string; points: number; max_points: number; reason: string }[] | null
}

export interface StudentQuestion {
  id: string
  type: QuestionType
  prompt: string
  choices: string[]
  /** Original choice indexes in this student's display order (shuffled per student). */
  choice_order: number[]
  points: number
  answer: string | null
}
