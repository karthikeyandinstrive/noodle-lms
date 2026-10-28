import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { createdAt, id, orgId, ts, updatedAt } from "./_common";
import { files, organizations, users } from "./core";
import { activities, courses } from "./courses";

const grade = () => numeric({ precision: 10, scale: 5, mode: "number" });

// ─── Assignment ─────────────────────────────────────────────────────────────

export const assignments = pgTable("assignments", {
  id: id(),
  organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
  activityId: uuid()
    .notNull()
    .unique()
    .references(() => activities.id, { onDelete: "cascade" }),
  instructions: text(),
  allowText: boolean().notNull().default(true),
  allowFiles: boolean().notNull().default(true),
  maxFiles: integer().notNull().default(5),
  maxFileBytes: integer().notNull().default(20 * 1024 * 1024),
  acceptedTypes: text().array().notNull().default([]),
  dueAt: ts(),
  cutoffAt: ts(),
  allowResubmit: boolean().notNull().default(true),
  gradeMax: grade().notNull().default(100),
  gradePass: grade(),
  blindMarking: boolean().notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const submissionStatus = pgEnum("submission_status", ["draft", "submitted", "graded", "reopened"]);

export const assignmentSubmissions = pgTable(
  "assignment_submissions",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    assignmentId: uuid()
      .notNull()
      .references(() => assignments.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    attempt: integer().notNull().default(1),
    status: submissionStatus().notNull().default("draft"),
    text: text(),
    submittedAt: ts(),
    late: boolean().notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("assignment_submissions_uq").on(t.assignmentId, t.userId, t.attempt)],
);

export const submissionFiles = pgTable(
  "submission_files",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    submissionId: uuid()
      .notNull()
      .references(() => assignmentSubmissions.id, { onDelete: "cascade" }),
    fileId: uuid()
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
  },
  (t) => [uniqueIndex("submission_files_uq").on(t.submissionId, t.fileId)],
);

export const assignmentFeedback = pgTable("assignment_feedback", {
  id: id(),
  organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
  submissionId: uuid()
    .notNull()
    .unique()
    .references(() => assignmentSubmissions.id, { onDelete: "cascade" }),
  graderId: uuid()
    .notNull()
    .references(() => users.id),
  grade: grade(),
  feedback: text(),
  gradedAt: ts().notNull().defaultNow(),
});

// ─── Question bank ──────────────────────────────────────────────────────────

export const questionCategories = pgTable("question_categories", {
  id: id(),
  organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
  /** null = shared across the organization */
  courseId: uuid().references(() => courses.id, { onDelete: "cascade" }),
  parentId: uuid().references((): AnyPgColumn => questionCategories.id, { onDelete: "cascade" }),
  name: text().notNull(),
  createdAt: createdAt(),
});

export const questionType = pgEnum("question_type", [
  "multichoice",
  "truefalse",
  "shortanswer",
  "numerical",
  "essay",
  "matching",
]);

export const questions = pgTable("questions", {
  id: id(),
  organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
  categoryId: uuid()
    .notNull()
    .references(() => questionCategories.id, { onDelete: "cascade" }),
  latestVersion: integer().notNull().default(1),
  createdBy: uuid(),
  createdAt: createdAt(),
  deletedAt: ts(),
});

/**
 * Immutable question versions. Attempts reference the exact version used,
 * so editing a question never changes historic attempts.
 * `data` shape depends on `type` — see @lms/api modules/quiz/question-types.ts.
 */
export const questionVersions = pgTable(
  "question_versions",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    questionId: uuid()
      .notNull()
      .references(() => questions.id, { onDelete: "cascade" }),
    version: integer().notNull(),
    type: questionType().notNull(),
    name: text().notNull(),
    text: text().notNull(),
    defaultMark: grade().notNull().default(1),
    data: jsonb().$type<Record<string, unknown>>().notNull(),
    generalFeedback: text(),
    createdBy: uuid(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("question_versions_uq").on(t.questionId, t.version)],
);

// ─── Quiz ───────────────────────────────────────────────────────────────────

export const gradeMethod = pgEnum("grade_method", ["highest", "average", "first", "last"]);

export const quizzes = pgTable("quizzes", {
  id: id(),
  organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
  activityId: uuid()
    .notNull()
    .unique()
    .references(() => activities.id, { onDelete: "cascade" }),
  intro: text(),
  openAt: ts(),
  closeAt: ts(),
  timeLimitSeconds: integer(),
  attemptsAllowed: integer().notNull().default(0),
  gradeMethod: gradeMethod().notNull().default("highest"),
  gradeMax: grade().notNull().default(10),
  gradePass: grade(),
  shuffleQuestions: boolean().notNull().default(false),
  shuffleAnswers: boolean().notNull().default(true),
  /** Which parts students see after an attempt. */
  reviewOptions: jsonb()
    .$type<{ marks: boolean; correctness: boolean; feedback: boolean; rightAnswer: boolean }>()
    .notNull()
    .default({ marks: true, correctness: true, feedback: true, rightAnswer: false }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const quizSlots = pgTable(
  "quiz_slots",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    quizId: uuid()
      .notNull()
      .references(() => quizzes.id, { onDelete: "cascade" }),
    questionId: uuid()
      .notNull()
      .references(() => questions.id),
    /** null = always use the latest version at attempt start */
    pinnedVersion: integer(),
    position: integer().notNull(),
    maxMark: grade().notNull().default(1),
  },
  (t) => [index("quiz_slots_quiz_idx").on(t.quizId, t.position)],
);

export const attemptStatus = pgEnum("attempt_status", ["in_progress", "finished", "abandoned"]);

export const quizAttempts = pgTable(
  "quiz_attempts",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    quizId: uuid()
      .notNull()
      .references(() => quizzes.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    attempt: integer().notNull(),
    status: attemptStatus().notNull().default("in_progress"),
    /** Slot order frozen at start (supports shuffling). */
    layout: jsonb().$type<string[]>().notNull(),
    startedAt: ts().notNull().defaultNow(),
    dueAt: ts(),
    finishedAt: ts(),
    sumMarks: grade(),
    grade: grade(),
    needsGrading: boolean().notNull().default(false),
  },
  (t) => [uniqueIndex("quiz_attempts_uq").on(t.quizId, t.userId, t.attempt)],
);

export const attemptAnswers = pgTable(
  "attempt_answers",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    attemptId: uuid()
      .notNull()
      .references(() => quizAttempts.id, { onDelete: "cascade" }),
    slotId: uuid()
      .notNull()
      .references(() => quizSlots.id, { onDelete: "cascade" }),
    questionVersionId: uuid()
      .notNull()
      .references(() => questionVersions.id),
    /** Per-attempt shuffled option order, so review shows what the student saw. */
    variant: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    response: jsonb().$type<unknown>(),
    fraction: numeric({ precision: 8, scale: 7, mode: "number" }),
    mark: grade(),
    maxMark: grade().notNull(),
    needsGrading: boolean().notNull().default(false),
    comment: text(),
    gradedBy: uuid(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("attempt_answers_uq").on(t.attemptId, t.slotId)],
);
