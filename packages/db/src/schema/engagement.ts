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
} from "drizzle-orm/pg-core";
import { createdAt, id, orgId, ts } from "./_common";
import { files, organizations, users } from "./core";
import { activities, courses } from "./courses";

// ─── Certificates ───────────────────────────────────────────────────────────

/**
 * Layout elements are positioned in millimetres on an A4 landscape page.
 * Text supports placeholders: {{fullname}}, {{coursename}}, {{date}}, {{code}}, {{grade}}.
 */
export type CertificateElement = {
  type: "text" | "image" | "qrcode";
  x: number;
  y: number;
  width?: number;
  fontSize?: number;
  color?: string;
  align?: "left" | "center" | "right";
  text?: string;
  fileId?: string;
};

export const certificateTemplates = pgTable("certificate_templates", {
  id: id(),
  organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
  name: text().notNull(),
  orientation: text().notNull().default("landscape"),
  backgroundFileId: uuid().references(() => files.id, { onDelete: "set null" }),
  elements: jsonb().$type<CertificateElement[]>().notNull().default([]),
  createdAt: createdAt(),
});

/** Certificate activity settings: which template, and when it may be issued. */
export const certificateActivities = pgTable("certificate_activities", {
  id: id(),
  organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
  activityId: uuid()
    .notNull()
    .unique()
    .references(() => activities.id, { onDelete: "cascade" }),
  templateId: uuid()
    .notNull()
    .references(() => certificateTemplates.id),
  requireCourseCompletion: boolean().notNull().default(true),
  minGradePercent: integer(),
  autoIssue: boolean().notNull().default(true),
  expiresAfterDays: integer(),
});

export const issuedCertificates = pgTable(
  "issued_certificates",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    certificateActivityId: uuid()
      .notNull()
      .references(() => certificateActivities.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    courseId: uuid()
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    /** Public, unguessable verification code. */
    code: text().notNull().unique(),
    fileId: uuid().references(() => files.id, { onDelete: "set null" }),
    /** Snapshot of the rendered values, so verification survives renames. */
    snapshot: jsonb().$type<Record<string, string>>().notNull(),
    issuedAt: ts().notNull().defaultNow(),
    expiresAt: ts(),
    revokedAt: ts(),
  },
  (t) => [uniqueIndex("issued_certificates_uq").on(t.certificateActivityId, t.userId)],
);

// ─── Badges ─────────────────────────────────────────────────────────────────

export type BadgeCriteria =
  | { type: "manual" }
  | { type: "course_completion"; courseId: string }
  | { type: "activities"; activityIds: string[] };

export const badges = pgTable("badges", {
  id: id(),
  organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
  /** null = site badge */
  courseId: uuid().references(() => courses.id, { onDelete: "cascade" }),
  name: text().notNull(),
  description: text().notNull(),
  imageFileId: uuid().references(() => files.id, { onDelete: "set null" }),
  criteria: jsonb().$type<BadgeCriteria>().notNull(),
  status: text().notNull().default("active"),
  expiresAfterDays: integer(),
  createdBy: uuid(),
  createdAt: createdAt(),
});

export const badgeIssues = pgTable(
  "badge_issues",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    badgeId: uuid()
      .notNull()
      .references(() => badges.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Public verification hash (Open Badges assertion id). */
    uniqueHash: text().notNull().unique(),
    issuedBy: uuid(),
    issuedAt: ts().notNull().defaultNow(),
    expiresAt: ts(),
    revokedAt: ts(),
  },
  (t) => [uniqueIndex("badge_issues_uq").on(t.badgeId, t.userId)],
);

// ─── Interactive content (H5P / embeds) ─────────────────────────────────────

export const interactiveKind = pgEnum("interactive_kind", ["h5p", "embed"]);

export const interactiveContents = pgTable("interactive_contents", {
  id: id(),
  organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
  activityId: uuid()
    .notNull()
    .unique()
    .references(() => activities.id, { onDelete: "cascade" }),
  kind: interactiveKind().notNull(),
  /** Uploaded .h5p package (extracted under `h5p/<id>/` in storage). */
  packageFileId: uuid().references(() => files.id, { onDelete: "set null" }),
  /** Allow-listed embed URL (YouTube, Vimeo, H5P.com, etc.). */
  embedUrl: text(),
  gradeMax: numeric({ precision: 10, scale: 5, mode: "number" }).notNull().default(100),
  settings: jsonb().$type<Record<string, unknown>>().notNull().default({}),
});

/** Scored results reported by the player via xAPI-style statements. */
export const interactiveResults = pgTable(
  "interactive_results",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    interactiveId: uuid()
      .notNull()
      .references(() => interactiveContents.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    rawScore: numeric({ mode: "number" }),
    maxScore: numeric({ mode: "number" }),
    completed: boolean().notNull().default(false),
    statement: jsonb(),
    createdAt: createdAt(),
  },
  (t) => [index("interactive_results_idx").on(t.interactiveId, t.userId)],
);

// ─── Video conferencing ─────────────────────────────────────────────────────

export const videoProvider = pgEnum("video_provider", ["jitsi", "zoom", "bigbluebutton", "custom"]);

export const videoMeetings = pgTable("video_meetings", {
  id: id(),
  organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
  activityId: uuid()
    .notNull()
    .unique()
    .references(() => activities.id, { onDelete: "cascade" }),
  provider: videoProvider().notNull().default("jitsi"),
  /** Jitsi room name, or external meeting URL for zoom/custom. */
  roomName: text(),
  joinUrl: text(),
  startsAt: ts().notNull(),
  durationMinutes: integer().notNull().default(60),
  recordingUrl: text(),
  createdAt: createdAt(),
});

export const videoAttendance = pgTable(
  "video_attendance",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    meetingId: uuid()
      .notNull()
      .references(() => videoMeetings.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    joinedAt: ts().notNull().defaultNow(),
  },
  (t) => [index("video_attendance_idx").on(t.meetingId, t.userId)],
);
