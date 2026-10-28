import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { createdAt, id, orgId, ts, updatedAt } from "./_common";
import { contexts, files, organizations, users } from "./core";

// ─── Categories & courses ───────────────────────────────────────────────────

export const courseCategories = pgTable("course_categories", {
  id: id(),
  organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
  parentId: uuid().references((): AnyPgColumn => courseCategories.id, { onDelete: "cascade" }),
  contextId: uuid()
    .notNull()
    .references(() => contexts.id),
  name: text().notNull(),
  description: text(),
  sortOrder: integer().notNull().default(0),
  visible: boolean().notNull().default(true),
  createdAt: createdAt(),
});

export const courses = pgTable(
  "courses",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    categoryId: uuid().references(() => courseCategories.id, { onDelete: "set null" }),
    contextId: uuid()
      .notNull()
      .references(() => contexts.id),
    fullname: text().notNull(),
    shortname: text().notNull(),
    summary: text(),
    format: text().notNull().default("topics"),
    visible: boolean().notNull().default(true),
    startDate: ts(),
    endDate: ts(),
    imageFileId: uuid().references(() => files.id, { onDelete: "set null" }),
    enableCompletion: boolean().notNull().default(true),
    /** Self-enrolment: open | key | closed. */
    selfEnrol: text().notNull().default("closed"),
    enrolmentKeyHash: text(),
    priceCents: integer(),
    currency: text(),
    createdBy: uuid(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("courses_org_shortname_uq").on(t.organizationId, t.shortname)],
);

export const courseSections = pgTable(
  "course_sections",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    courseId: uuid()
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    title: text().notNull(),
    summary: text(),
    position: integer().notNull(),
    visible: boolean().notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index("course_sections_course_idx").on(t.courseId, t.position)],
);

// ─── Activities (Moodle "course modules") ───────────────────────────────────

export const activityType = pgEnum("activity_type", [
  "page",
  "url",
  "file",
  "assignment",
  "quiz",
  "forum",
  "workshop",
  "attendance",
  "interactive",
  "video",
  "certificate",
  "lti",
  "scorm",
]);

export const completionRule = pgEnum("completion_rule", ["none", "manual", "view", "submit", "grade", "pass"]);

/**
 * Generic activity record placed in a course section. Type-specific settings
 * live in the module's own table keyed by `activity_id` (e.g. assignments).
 */
export const activities = pgTable(
  "activities",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    courseId: uuid()
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    sectionId: uuid()
      .notNull()
      .references(() => courseSections.id, { onDelete: "cascade" }),
    contextId: uuid()
      .notNull()
      .references(() => contexts.id),
    type: activityType().notNull(),
    name: text().notNull(),
    description: text(),
    position: integer().notNull(),
    visible: boolean().notNull().default(true),
    availableFrom: ts(),
    availableUntil: ts(),
    completionRule: completionRule().notNull().default("none"),
    groupMode: text().notNull().default("none"),
    createdBy: uuid(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("activities_course_idx").on(t.courseId, t.sectionId, t.position)],
);

/** Simple content activities (page / url / file). */
export const contentResources = pgTable("content_resources", {
  id: id(),
  organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
  activityId: uuid()
    .notNull()
    .unique()
    .references(() => activities.id, { onDelete: "cascade" }),
  /** Sanitized HTML for pages. */
  content: text(),
  externalUrl: text(),
  fileId: uuid().references(() => files.id, { onDelete: "set null" }),
});

// ─── Enrolment, groups ──────────────────────────────────────────────────────

export const enrolmentMethod = pgEnum("enrolment_method", ["manual", "self", "payment", "cohort"]);
export const enrolmentStatus = pgEnum("enrolment_status", ["active", "suspended"]);

export const enrolments = pgTable(
  "enrolments",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    courseId: uuid()
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    method: enrolmentMethod().notNull(),
    status: enrolmentStatus().notNull().default("active"),
    cohortId: uuid(),
    timeStart: ts(),
    timeEnd: ts(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("enrolments_course_user_uq").on(t.courseId, t.userId), index("enrolments_user_idx").on(t.userId)],
);

export const groups = pgTable("groups", {
  id: id(),
  organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
  courseId: uuid()
    .notNull()
    .references(() => courses.id, { onDelete: "cascade" }),
  name: text().notNull(),
  description: text(),
  createdAt: createdAt(),
});

export const groupMembers = pgTable(
  "group_members",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    groupId: uuid()
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [uniqueIndex("group_members_uq").on(t.groupId, t.userId)],
);

// ─── Completion ─────────────────────────────────────────────────────────────

export const completionState = pgEnum("completion_state", ["incomplete", "complete", "complete_pass", "complete_fail"]);

export const activityCompletions = pgTable(
  "activity_completions",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    activityId: uuid()
      .notNull()
      .references(() => activities.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    state: completionState().notNull().default("incomplete"),
    viewedAt: ts(),
    completedAt: ts(),
    overriddenBy: uuid(),
  },
  (t) => [uniqueIndex("activity_completions_uq").on(t.activityId, t.userId)],
);

export const courseCompletions = pgTable(
  "course_completions",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    courseId: uuid()
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    completedAt: ts().notNull().defaultNow(),
    data: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [uniqueIndex("course_completions_uq").on(t.courseId, t.userId)],
);
