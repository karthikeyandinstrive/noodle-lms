import { z } from "zod";

/**
 * Course backup format ("lms-backup", version 1). A ZIP with:
 *
 *   manifest.json   BackupManifest — format/version, source org, course metadata, options, counts
 *   course.json     BackupCourse   — structure + settings (+ optional user data)
 *   files/<fileId>/<filename>      — file bodies when `includeFiles` (listed in course.json `files`)
 *
 * Ids inside course.json are the SOURCE ids; they only link records together
 * within the backup and are remapped on restore. Dates are ISO strings.
 */

export const BACKUP_FORMAT = "lms-backup";
export const BACKUP_VERSION = 1;

/** Restores reject archives above these sizes. */
export const MAX_ARCHIVE_BYTES = 500 * 1024 * 1024;
export const MAX_COURSE_JSON_BYTES = 100 * 1024 * 1024;
export const MAX_ACTIVITIES = 5000;

export type BackupManifest = {
  format: typeof BACKUP_FORMAT;
  version: number;
  createdAt: string;
  source: { organizationId: string; organizationName: string; organizationSlug: string; courseId: string; app: string };
  course: { fullname: string; shortname: string };
  options: { includeUserData: boolean; includeFiles: boolean };
  counts: Record<string, number>;
};

export type BackupActivity = {
  id: string;
  sectionId: string;
  type: string;
  name: string;
  description: string | null;
  position: number;
  visible: boolean;
  availableFrom: string | null;
  availableUntil: string | null;
  completionRule: string;
  groupMode: string;
  /** Type-specific settings read from the module table (see export.ts). */
  data: Record<string, unknown> | null;
};

export type BackupQuestion = {
  id: string;
  categoryId: string;
  latestVersion: number;
  versions: { version: number; type: string; name: string; text: string; defaultMark: number; data: Record<string, unknown>; generalFeedback: string | null }[];
};

export type BackupFile = { id: string; filename: string; mimeType: string; size: number; path: string };

export type BackupCourse = {
  course: {
    fullname: string;
    shortname: string;
    summary: string | null;
    format: string;
    visible: boolean;
    startDate: string | null;
    endDate: string | null;
    enableCompletion: boolean;
    selfEnrol: string;
    priceCents: number | null;
    currency: string | null;
    imageFileId: string | null;
  };
  sections: { id: string; title: string; summary: string | null; position: number; visible: boolean }[];
  activities: BackupActivity[];
  questionBank: { categories: { id: string; parentId: string | null; name: string; shared: boolean }[]; questions: BackupQuestion[] };
  certificateTemplates: { id: string; name: string; orientation: string; backgroundFileId: string | null; elements: unknown[] }[];
  gradebook: {
    categories: { id: string; parentId: string | null; name: string; aggregation: string; dropLowest: number }[];
    items: {
      id: string;
      categoryId: string | null;
      type: string;
      activityId: string | null;
      name: string;
      gradeMax: number;
      gradeMin: number;
      gradePass: number | null;
      weight: number;
      hidden: boolean;
      locked: boolean;
      position: number;
    }[];
  };
  groups: { id: string; name: string; description: string | null }[];
  badges: { id: string; name: string; description: string; imageFileId: string | null; criteria: Record<string, unknown>; status: string; expiresAfterDays: number | null }[];
  files: BackupFile[];
  userData?: {
    users: { id: string; email: string; firstName: string; lastName: string }[];
    enrolments: { userId: string; status: string; method: string; roles: string[]; timeStart: string | null; timeEnd: string | null }[];
    groupMembers: { groupId: string; userId: string }[];
    grades: { itemId: string; userId: string; rawGrade: number | null; finalGrade: number | null; overridden: boolean; feedback: string | null }[];
    submissions: {
      activityId: string;
      userId: string;
      attempt: number;
      status: string;
      text: string | null;
      submittedAt: string | null;
      late: boolean;
      fileIds: string[];
      grade: number | null;
      feedback: string | null;
    }[];
    forumDiscussions: { id: string; activityId: string; userId: string; groupId: string | null; title: string; pinned: boolean; locked: boolean; createdAt: string }[];
    forumPosts: { id: string; discussionId: string; parentId: string | null; userId: string; message: string; createdAt: string; deleted: boolean }[];
    quizAttempts: {
      activityId: string;
      userId: string;
      attempt: number;
      /** Slot ids (from the quiz's backup slots) in the order the learner saw them. */
      layout: string[];
      startedAt: string;
      finishedAt: string | null;
      sumMarks: number | null;
      grade: number | null;
      needsGrading: boolean;
      answers: {
        slotId: string;
        questionId: string;
        version: number;
        variant: Record<string, unknown>;
        response: unknown;
        fraction: number | null;
        mark: number | null;
        maxMark: number;
        needsGrading: boolean;
        comment: string | null;
      }[];
    }[];
    attendanceRecords: { sessionId: string; userId: string; status: string; remarks: string | null; takenAt: string }[];
  };
};

// ─── Validation of untrusted archives (structure only; type data is validated per type on restore) ──

const zStr = z.string().max(1_000_000);
const zNullStr = zStr.nullable();
const zIdish = z.string().min(1).max(100);

export const zManifest = z.object({
  format: z.literal(BACKUP_FORMAT),
  version: z.number().int(),
  createdAt: z.string().max(100),
  source: z.object({ organizationId: z.string().max(100), organizationName: z.string().max(500).optional(), courseId: z.string().max(100) }).passthrough(),
  course: z.object({ fullname: z.string().max(500), shortname: z.string().max(200) }),
  options: z.object({ includeUserData: z.boolean(), includeFiles: z.boolean() }).partial().default({}),
});

export const zBackupCourse = z.object({
  course: z
    .object({
      fullname: z.string().min(1).max(255),
      shortname: z.string().min(1).max(100),
      summary: zNullStr.default(null),
      format: z.string().max(50).default("topics"),
      visible: z.boolean().default(true),
      startDate: zNullStr.default(null),
      endDate: zNullStr.default(null),
      enableCompletion: z.boolean().default(true),
      selfEnrol: z.string().max(20).default("closed"),
      priceCents: z.number().int().nullable().default(null),
      currency: z.string().max(3).nullable().default(null),
      imageFileId: z.string().max(100).nullable().default(null),
    })
    .passthrough(),
  sections: z
    .array(z.object({ id: zIdish, title: z.string().max(255), summary: zNullStr.default(null), position: z.number().int(), visible: z.boolean().default(true) }))
    .max(1000),
  activities: z
    .array(
      z.object({
        id: zIdish,
        sectionId: zIdish,
        type: z.string().max(30),
        name: z.string().min(1).max(255),
        description: zNullStr.default(null),
        position: z.number().int(),
        visible: z.boolean().default(true),
        availableFrom: zNullStr.default(null),
        availableUntil: zNullStr.default(null),
        completionRule: z.string().max(20).default("none"),
        groupMode: z.string().max(20).default("none"),
        data: z.record(z.string(), z.unknown()).nullable().default(null),
      }),
    )
    .max(MAX_ACTIVITIES),
  questionBank: z
    .object({
      categories: z.array(z.object({ id: zIdish, parentId: z.string().max(100).nullable(), name: z.string().max(255), shared: z.boolean().default(false) })).max(10_000),
      questions: z
        .array(
          z.object({
            id: zIdish,
            categoryId: zIdish,
            latestVersion: z.number().int().min(1),
            versions: z
              .array(
                z.object({
                  version: z.number().int().min(1),
                  type: z.string().max(30),
                  name: z.string().max(255),
                  text: zStr,
                  defaultMark: z.number().min(0).default(1),
                  data: z.record(z.string(), z.unknown()),
                  generalFeedback: zNullStr.default(null),
                }),
              )
              .min(1)
              .max(1000),
          }),
        )
        .max(50_000),
    })
    .default({ categories: [], questions: [] }),
  certificateTemplates: z
    .array(z.object({ id: zIdish, name: z.string().max(255), orientation: z.string().max(20).default("landscape"), backgroundFileId: z.string().max(100).nullable().default(null), elements: z.array(z.unknown()).max(500) }))
    .max(1000)
    .default([]),
  gradebook: z
    .object({
      categories: z.array(z.object({ id: zIdish, parentId: z.string().max(100).nullable(), name: z.string().max(255), aggregation: z.string().max(30), dropLowest: z.number().int().min(0).default(0) })).max(1000),
      items: z
        .array(
          z.object({
            id: zIdish,
            categoryId: z.string().max(100).nullable(),
            type: z.string().max(20),
            activityId: z.string().max(100).nullable(),
            name: z.string().max(255),
            gradeMax: z.number(),
            gradeMin: z.number().default(0),
            gradePass: z.number().nullable().default(null),
            weight: z.number().default(1),
            hidden: z.boolean().default(false),
            locked: z.boolean().default(false),
            position: z.number().int().default(0),
          }),
        )
        .max(10_000),
    })
    .default({ categories: [], items: [] }),
  groups: z.array(z.object({ id: zIdish, name: z.string().max(255), description: zNullStr.default(null) })).max(5000).default([]),
  badges: z
    .array(
      z.object({
        id: zIdish,
        name: z.string().max(255),
        description: z.string().max(10_000),
        imageFileId: z.string().max(100).nullable().default(null),
        criteria: z.record(z.string(), z.unknown()),
        status: z.string().max(20).default("active"),
        expiresAfterDays: z.number().int().nullable().default(null),
      }),
    )
    .max(1000)
    .default([]),
  files: z
    .array(z.object({ id: zIdish, filename: z.string().max(255), mimeType: z.string().max(255), size: z.number().int().min(0), path: z.string().max(500) }))
    .max(50_000)
    .default([]),
  userData: z
    .object({
      users: z.array(z.object({ id: zIdish, email: z.string().max(320), firstName: z.string().max(255), lastName: z.string().max(255) })).max(200_000),
      enrolments: z
        .array(z.object({ userId: zIdish, status: z.string().max(20), method: z.string().max(20), roles: z.array(z.string().max(50)).max(20), timeStart: zNullStr, timeEnd: zNullStr }))
        .max(200_000),
      groupMembers: z.array(z.object({ groupId: zIdish, userId: zIdish })).max(500_000).default([]),
      grades: z
        .array(
          z.object({
            itemId: zIdish,
            userId: zIdish,
            rawGrade: z.number().nullable().default(null),
            finalGrade: z.number().nullable().default(null),
            overridden: z.boolean().default(false),
            feedback: zNullStr.default(null),
          }),
        )
        .max(2_000_000)
        .default([]),
      submissions: z
        .array(
          z.object({
            activityId: zIdish,
            userId: zIdish,
            attempt: z.number().int().min(1).max(1000).default(1),
            status: z.string().max(20),
            text: zNullStr.default(null),
            submittedAt: zNullStr.default(null),
            late: z.boolean().default(false),
            fileIds: z.array(zIdish).max(100).default([]),
            grade: z.number().nullable().default(null),
            feedback: zNullStr.default(null),
          }),
        )
        .max(1_000_000)
        .default([]),
      forumDiscussions: z
        .array(
          z.object({
            id: zIdish,
            activityId: zIdish,
            userId: zIdish,
            groupId: z.string().max(100).nullable().default(null),
            title: z.string().max(500),
            pinned: z.boolean().default(false),
            locked: z.boolean().default(false),
            createdAt: z.string().max(100),
          }),
        )
        .max(500_000)
        .default([]),
      forumPosts: z
        .array(
          z.object({
            id: zIdish,
            discussionId: zIdish,
            parentId: z.string().max(100).nullable().default(null),
            userId: zIdish,
            message: zStr,
            createdAt: z.string().max(100),
            deleted: z.boolean().default(false),
          }),
        )
        .max(2_000_000)
        .default([]),
      quizAttempts: z
        .array(
          z.object({
            activityId: zIdish,
            userId: zIdish,
            attempt: z.number().int().min(1).max(10_000),
            layout: z.array(zIdish).max(1000),
            startedAt: z.string().max(100),
            finishedAt: zNullStr.default(null),
            sumMarks: z.number().nullable().default(null),
            grade: z.number().nullable().default(null),
            needsGrading: z.boolean().default(false),
            answers: z
              .array(
                z.object({
                  slotId: zIdish,
                  questionId: zIdish,
                  version: z.number().int().min(1),
                  variant: z.record(z.string(), z.unknown()).default({}),
                  response: z.unknown().optional(),
                  fraction: z.number().nullable().default(null),
                  mark: z.number().nullable().default(null),
                  maxMark: z.number().min(0),
                  needsGrading: z.boolean().default(false),
                  comment: zNullStr.default(null),
                }),
              )
              .max(1000),
          }),
        )
        .max(500_000)
        .default([]),
      attendanceRecords: z
        .array(z.object({ sessionId: zIdish, userId: zIdish, status: z.string().max(20), remarks: zNullStr.default(null), takenAt: z.string().max(100) }))
        .max(2_000_000)
        .default([]),
    })
    .passthrough()
    .optional(),
});

export type ParsedBackupCourse = z.infer<typeof zBackupCourse>;

/** Restore report stored on the course_backups row. */
export type RestoreReport = {
  source?: { format: string; version?: number; organization?: string; course?: string };
  counts: Record<string, number>;
  warnings: string[];
  unsupported: string[];
};
