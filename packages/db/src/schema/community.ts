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
import { organizations, users } from "./core";
import { activities, groups } from "./courses";

const grade = () => numeric({ precision: 10, scale: 5, mode: "number" });

// ─── Forum ──────────────────────────────────────────────────────────────────

export const forumType = pgEnum("forum_type", ["general", "news", "qanda", "single"]);

export const forums = pgTable("forums", {
  id: id(),
  organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
  activityId: uuid()
    .notNull()
    .unique()
    .references(() => activities.id, { onDelete: "cascade" }),
  type: forumType().notNull().default("general"),
  intro: text(),
  /** optional | forced | disabled */
  subscriptionMode: text().notNull().default("optional"),
  /** Posts required for "submit" completion. */
  completionPosts: integer().notNull().default(0),
  createdAt: createdAt(),
});

export const forumDiscussions = pgTable(
  "forum_discussions",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    forumId: uuid()
      .notNull()
      .references(() => forums.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    groupId: uuid().references(() => groups.id, { onDelete: "set null" }),
    title: text().notNull(),
    pinned: boolean().notNull().default(false),
    locked: boolean().notNull().default(false),
    lastPostAt: ts().notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [index("forum_discussions_forum_idx").on(t.forumId, t.lastPostAt)],
);

export const forumPosts = pgTable(
  "forum_posts",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    discussionId: uuid()
      .notNull()
      .references(() => forumDiscussions.id, { onDelete: "cascade" }),
    parentId: uuid().references((): AnyPgColumn => forumPosts.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Sanitized HTML. */
    message: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts(),
  },
  (t) => [index("forum_posts_discussion_idx").on(t.discussionId, t.createdAt)],
);

export const forumSubscriptions = pgTable(
  "forum_subscriptions",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    forumId: uuid()
      .notNull()
      .references(() => forums.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [uniqueIndex("forum_subscriptions_uq").on(t.forumId, t.userId)],
);

// ─── Workshop (peer assessment) ─────────────────────────────────────────────

export const workshopPhase = pgEnum("workshop_phase", ["setup", "submission", "assessment", "evaluation", "closed"]);

export const workshops = pgTable("workshops", {
  id: id(),
  organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
  activityId: uuid()
    .notNull()
    .unique()
    .references(() => activities.id, { onDelete: "cascade" }),
  instructions: text(),
  assessmentInstructions: text(),
  phase: workshopPhase().notNull().default("setup"),
  submissionEndAt: ts(),
  assessmentEndAt: ts(),
  /** Max grade for the submission itself. */
  submissionGradeMax: grade().notNull().default(80),
  /** Max grade for quality of the peer assessments a student gave. */
  assessmentGradeMax: grade().notNull().default(20),
  reviewsPerSubmission: integer().notNull().default(3),
  allowSelfAssessment: boolean().notNull().default(false),
  /** Rubric criteria: [{ id, description, maxScore, weight }] */
  criteria: jsonb()
    .$type<{ id: string; description: string; maxScore: number; weight: number }[]>()
    .notNull()
    .default([]),
  createdAt: createdAt(),
});

export const workshopSubmissions = pgTable(
  "workshop_submissions",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    workshopId: uuid()
      .notNull()
      .references(() => workshops.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text().notNull(),
    content: text(),
    fileIds: uuid().array().notNull().default([]),
    grade: grade(),
    gradeOverride: grade(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("workshop_submissions_uq").on(t.workshopId, t.userId)],
);

export const workshopAssessments = pgTable(
  "workshop_assessments",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    submissionId: uuid()
      .notNull()
      .references(() => workshopSubmissions.id, { onDelete: "cascade" }),
    reviewerId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** { [criterionId]: score } */
    scores: jsonb().$type<Record<string, number>>(),
    /** 0-100 normalized grade this reviewer gave the submission. */
    grade: grade(),
    /** Quality-of-assessment grade the reviewer earns (computed in evaluation). */
    gradingGrade: grade(),
    feedback: text(),
    submittedAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("workshop_assessments_uq").on(t.submissionId, t.reviewerId)],
);

// ─── Attendance ─────────────────────────────────────────────────────────────

export const attendanceStatus = pgEnum("attendance_status", ["present", "late", "excused", "absent"]);

export const attendances = pgTable("attendances", {
  id: id(),
  organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
  activityId: uuid()
    .notNull()
    .unique()
    .references(() => activities.id, { onDelete: "cascade" }),
  gradeMax: grade().notNull().default(100),
  /** Points per status, e.g. { present: 2, late: 1, excused: 1, absent: 0 } */
  statusPoints: jsonb()
    .$type<Record<"present" | "late" | "excused" | "absent", number>>()
    .notNull()
    .default({ present: 2, late: 1, excused: 1, absent: 0 }),
  allowSelfMarking: boolean().notNull().default(false),
  createdAt: createdAt(),
});

export const attendanceSessions = pgTable(
  "attendance_sessions",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    attendanceId: uuid()
      .notNull()
      .references(() => attendances.id, { onDelete: "cascade" }),
    groupId: uuid().references(() => groups.id, { onDelete: "set null" }),
    startsAt: ts().notNull(),
    durationMinutes: integer().notNull().default(60),
    description: text(),
    /** Optional code students enter to self-mark present. */
    selfMarkCodeHash: text(),
    takenAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [index("attendance_sessions_idx").on(t.attendanceId, t.startsAt)],
);

export const attendanceRecords = pgTable(
  "attendance_records",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    sessionId: uuid()
      .notNull()
      .references(() => attendanceSessions.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: attendanceStatus().notNull(),
    remarks: text(),
    takenBy: uuid(),
    takenAt: ts().notNull().defaultNow(),
  },
  (t) => [uniqueIndex("attendance_records_uq").on(t.sessionId, t.userId)],
);
