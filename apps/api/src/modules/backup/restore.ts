import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  activities,
  assignments,
  attendances,
  attendanceSessions,
  badges,
  certificateActivities,
  certificateTemplates,
  contentResources,
  courseCategories,
  courseSections,
  courses,
  createContext,
  files,
  forums,
  getSystemContext,
  gradeCategories,
  gradeItems,
  groups,
  interactiveContents,
  ltiLinks,
  ltiTools,
  questionCategories,
  questions,
  questionVersions,
  quizSlots,
  quizzes,
  scormPackages,
  users,
  videoMeetings,
  workshops,
  type DB,
} from "@lms/db";
import { z } from "zod";
import { activityType, type ActivityRow, type ActivityType } from "../../core/activity-types";
import { emitInTx } from "../../core/events";
import { storeBuffer } from "../../core/files";
import { cleanHtml } from "../../core/sanitize";
import { zElement } from "../certificate/service";
import { normalizeExternalUrl, parseOptions, type FileOptions, type UrlOptions } from "../content/options";
import { enrolUser, ENROLABLE_ROLES, type EnrolRole } from "../courses/service";
import { ensureCourseGradebook, syncActivityGradeItem } from "../gradebook/service";
import { DATA_SCHEMAS, QUESTION_TYPES, type QuestionType } from "../quiz/question-types";
import { fileIdsInHtml } from "./export";
import type { ParsedBackupCourse, RestoreReport } from "./format";

const ACTIVITY_TYPES = ["page", "url", "file", "assignment", "quiz", "forum", "workshop", "attendance", "interactive", "video", "certificate", "lti", "scorm"] as const;
const COMPLETION_RULES = ["none", "manual", "view", "submit", "grade", "pass"] as const;
const GROUP_MODES = ["none", "separate", "visible"] as const;
const AGGREGATIONS = ["mean", "weighted_mean", "sum", "highest", "lowest", "median"] as const;

// ─── Per-type validation of untrusted settings ──────────────────────────────

const zD = z.preprocess((v) => (v === null || v === undefined || v === "" ? null : new Date(v as string)), z.date().nullable()).optional();
const zHtml = z.string().max(1_000_000).nullable().optional();
const zNum = z.coerce.number().finite();

const TYPE_SCHEMAS = {
  content: z.object({ content: zHtml, externalUrl: z.string().max(4000).nullable().optional(), fileId: z.string().max(100).nullable().optional() }),
  assignment: z.object({
    instructions: zHtml,
    allowText: z.boolean().default(true),
    allowFiles: z.boolean().default(true),
    maxFiles: z.number().int().min(0).max(100).default(5),
    maxFileBytes: z.number().int().min(0).default(20 * 1024 * 1024),
    acceptedTypes: z.array(z.string().max(100)).max(100).default([]),
    dueAt: zD,
    cutoffAt: zD,
    allowResubmit: z.boolean().default(true),
    gradeMax: zNum.default(100),
    gradePass: zNum.nullable().optional(),
    blindMarking: z.boolean().default(false),
  }),
  quiz: z.object({
    intro: zHtml,
    openAt: zD,
    closeAt: zD,
    timeLimitSeconds: z.number().int().min(0).nullable().optional(),
    attemptsAllowed: z.number().int().min(0).default(0),
    gradeMethod: z.enum(["highest", "average", "first", "last"]).default("highest"),
    gradeMax: zNum.default(10),
    gradePass: zNum.nullable().optional(),
    shuffleQuestions: z.boolean().default(false),
    shuffleAnswers: z.boolean().default(true),
    reviewOptions: z.object({ marks: z.boolean(), correctness: z.boolean(), feedback: z.boolean(), rightAnswer: z.boolean() }).optional(),
    slots: z
      .array(z.object({ questionId: z.string().max(100), pinnedVersion: z.number().int().nullable().optional(), position: z.number().int(), maxMark: zNum.default(1) }))
      .max(1000)
      .default([]),
  }),
  forum: z.object({
    type: z.enum(["general", "news", "qanda", "single"]).default("general"),
    intro: zHtml,
    subscriptionMode: z.enum(["optional", "forced", "disabled"]).default("optional"),
    completionPosts: z.number().int().min(0).default(0),
  }),
  workshop: z.object({
    instructions: zHtml,
    assessmentInstructions: zHtml,
    phase: z.enum(["setup", "submission", "assessment", "evaluation", "closed"]).default("setup"),
    submissionEndAt: zD,
    assessmentEndAt: zD,
    submissionGradeMax: zNum.default(80),
    assessmentGradeMax: zNum.default(20),
    reviewsPerSubmission: z.number().int().min(0).default(3),
    allowSelfAssessment: z.boolean().default(false),
    criteria: z.array(z.object({ id: z.string().max(100), description: z.string().max(10_000), maxScore: zNum, weight: zNum })).max(100).default([]),
  }),
  attendance: z.object({
    gradeMax: zNum.default(100),
    statusPoints: z.object({ present: zNum, late: zNum, excused: zNum, absent: zNum }).optional(),
    allowSelfMarking: z.boolean().default(false),
    sessions: z
      .array(z.object({ groupId: z.string().max(100).nullable().optional(), startsAt: z.preprocess((v) => new Date(v as string), z.date()), durationMinutes: z.number().int().min(0).default(60), description: zHtml }))
      .max(5000)
      .default([]),
  }),
  interactive: z.object({
    kind: z.enum(["h5p", "embed"]).default("embed"),
    packageFileId: z.string().max(100).nullable().optional(),
    embedUrl: z.string().max(4000).nullable().optional(),
    gradeMax: zNum.default(100),
    settings: z.record(z.string(), z.unknown()).default({}),
  }),
  video: z.object({
    provider: z.enum(["jitsi", "zoom", "bigbluebutton", "custom"]).default("jitsi"),
    roomName: z.string().max(500).nullable().optional(),
    joinUrl: z.string().max(4000).nullable().optional(),
    startsAt: z.preprocess((v) => (v ? new Date(v as string) : new Date()), z.date()),
    durationMinutes: z.number().int().min(0).default(60),
    recordingUrl: z.string().max(4000).nullable().optional(),
  }),
  certificate: z.object({
    templateId: z.string().max(100),
    requireCourseCompletion: z.boolean().default(true),
    minGradePercent: z.number().int().nullable().optional(),
    autoIssue: z.boolean().default(true),
    expiresAfterDays: z.number().int().nullable().optional(),
  }),
  lti: z.object({
    toolName: z.string().max(500).optional(),
    toolId: z.string().max(100).optional(),
    targetLinkUri: z.string().max(4000).nullable().optional(),
    customParams: z.record(z.string(), z.string().max(4000)).default({}),
    gradeMax: zNum.nullable().optional(),
    openInNewWindow: z.boolean().default(false),
  }),
  scorm: z.object({
    packageFileId: z.string().max(100).nullable().optional(),
    version: z.enum(["1.2", "2004"]),
    entryHref: z.string().max(2000),
    storagePrefix: z.string().max(2000),
    title: z.string().max(1000).nullable().optional(),
    manifest: z.record(z.string(), z.unknown()).default({}),
    gradeMax: zNum.default(100),
    gradeMethod: z.string().max(20).default("highest"),
    maxAttempts: z.number().int().min(0).default(0),
  }),
} as const;

const oneOf = <T extends readonly string[]>(list: T, v: string, fallback: T[number]): T[number] => ((list as readonly string[]).includes(v) ? (v as T[number]) : fallback);

function toDate(v: string | null | undefined) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export type RestoreInput = {
  organizationId: string;
  userId: string;
  backup: ParsedBackupCourse;
  /** Archive contents (for `files/...` entries). */
  archive: Map<string, Buffer>;
  sourceOrganizationId: string | null;
  categoryId?: string | null;
  fullname?: string | null;
  shortname?: string | null;
  /** Enrol users found by email in this organization (from the backup's user data). */
  restoreEnrolments?: boolean;
  report: RestoreReport;
};

async function uniqueShortname(tx: DB, base: string) {
  const root = base.slice(0, 90);
  for (let i = 0; i < 1000; i++) {
    const candidate = i === 0 ? root : `${root}_${i}`;
    const [taken] = await tx.select({ id: courses.id }).from(courses).where(sql`lower(${courses.shortname}) = lower(${candidate})`).limit(1);
    if (!taken) return candidate;
  }
  return `${root}_${crypto.randomUUID().slice(0, 8)}`;
}

const bump = (report: RestoreReport, key: string, n = 1) => {
  report.counts[key] = (report.counts[key] ?? 0) + n;
};

/**
 * Creates a NEW course from a parsed backup, remapping every id. Runs inside one
 * tenant transaction: on failure nothing is created (stored blobs may remain).
 */
export async function restoreCourse(tx: DB, input: RestoreInput) {
  const { organizationId, userId, backup, report } = input;
  const sameOrg = input.sourceOrganizationId === organizationId;
  const warn = (m: string) => report.warnings.push(m);
  const system = await getSystemContext(tx, organizationId);

  // ─── Course ────────────────────────────────────────────────────────────────
  let parentContextId = system.id;
  if (input.categoryId) {
    const [cat] = await tx.select().from(courseCategories).where(eq(courseCategories.id, input.categoryId)).limit(1);
    if (!cat) throw new Error("Category not found");
    parentContextId = cat.contextId;
  }
  const src = backup.course;
  const courseId = crypto.randomUUID();
  const ctx = await createContext(tx, { organizationId, level: "course", instanceId: courseId, parentId: parentContextId });
  const shortname = await uniqueShortname(tx, (input.shortname || src.shortname).trim() || "restored");
  if (shortname !== (input.shortname || src.shortname)) warn(`Short name changed to "${shortname}" (the original is already in use)`);
  let selfEnrol = oneOf(["open", "key", "closed"] as const, src.selfEnrol, "closed");
  if (selfEnrol === "key") {
    selfEnrol = "closed";
    warn("Self enrolment with a key was turned off: enrolment keys are not included in backups");
  }

  // ─── Files (lazy: stored on first use, tagged for that use) ────────────────
  const fileEntries = new Map(backup.files.map((f) => [f.id.toLowerCase(), f]));
  const fileMap = new Map<string, string>();
  type Tag = { component: string; area: string; itemId?: string | null; contextId?: string | null };
  const restoreFile = async (oldId: unknown, tag: Tag): Promise<string | null> => {
    if (typeof oldId !== "string" || !oldId) return null;
    const key = oldId.toLowerCase();
    if (fileMap.has(key)) return fileMap.get(key)!;
    const entry = fileEntries.get(key);
    const body = entry ? input.archive.get(entry.path) : undefined;
    if (!entry || !body) return null;
    const stored = await storeBuffer(tx, organizationId, {
      ...tag,
      ownerId: userId,
      filename: entry.filename,
      mimeType: entry.mimeType || "application/octet-stream",
      body,
    });
    fileMap.set(key, stored.id);
    bump(report, "files");
    return stored.id;
  };
  /** Sanitizes HTML and rewrites embedded file links to the restored copies. */
  const html = async (value: string | null | undefined, contextId: string) => {
    if (!value) return null;
    let out = value;
    for (const id of fileIdsInHtml(value)) {
      const next = await restoreFile(id, { component: "content", area: "embedded", contextId });
      if (next) out = out.replace(new RegExp(id, "gi"), next);
    }
    return cleanHtml(out);
  };

  const [course] = await tx
    .insert(courses)
    .values({
      id: courseId,
      organizationId,
      categoryId: input.categoryId ?? null,
      contextId: ctx.id,
      fullname: (input.fullname || src.fullname).slice(0, 255),
      shortname,
      summary: null,
      format: oneOf(["topics", "weeks", "single"] as const, src.format, "topics"),
      visible: src.visible,
      startDate: toDate(src.startDate),
      endDate: toDate(src.endDate),
      enableCompletion: src.enableCompletion,
      selfEnrol,
      priceCents: src.priceCents,
      currency: src.currency,
      createdBy: userId,
    })
    .returning();
  const summary = await html(src.summary, ctx.id);
  const imageFileId = await restoreFile(src.imageFileId, { component: "course", area: "image", itemId: courseId, contextId: ctx.id });
  if (summary || imageFileId) await tx.update(courses).set({ summary, imageFileId }).where(eq(courses.id, courseId));
  const root = await ensureCourseGradebook(tx, { organizationId, courseId });
  await enrolUser(tx, { organizationId, course: course!, userId, method: "manual", role: "editing_teacher", assignedBy: userId });

  // ─── Sections & groups ─────────────────────────────────────────────────────
  const sectionMap = new Map<string, string>();
  const sortedSections = [...backup.sections].sort((a, b) => a.position - b.position);
  for (const [i, s] of sortedSections.entries()) {
    const [row] = await tx
      .insert(courseSections)
      .values({ organizationId, courseId, title: s.title.slice(0, 255) || `Section ${i}`, summary: await html(s.summary, ctx.id), position: i, visible: s.visible })
      .returning();
    sectionMap.set(s.id, row!.id);
  }
  if (!sectionMap.size) {
    const [row] = await tx.insert(courseSections).values({ organizationId, courseId, title: "General", position: 0 }).returning();
    sectionMap.set("__default", row!.id);
  }
  const firstSectionId = sectionMap.values().next().value as string;
  bump(report, "sections", sectionMap.size);

  const groupMap = new Map<string, string>();
  for (const g of backup.groups) {
    const [row] = await tx.insert(groups).values({ organizationId, courseId, name: g.name, description: g.description }).returning();
    groupMap.set(g.id, row!.id);
  }
  bump(report, "groups", groupMap.size);

  // ─── Question bank (recreated in the new course's bank) ────────────────────
  const qCatMap = new Map<string, string>();
  const pendingCats = [...backup.questionBank.categories];
  const knownCats = new Set(pendingCats.map((c) => c.id));
  while (pendingCats.length) {
    const ready = pendingCats.filter((c) => !c.parentId || !knownCats.has(c.parentId) || qCatMap.has(c.parentId));
    if (!ready.length) {
      warn("Question categories contain a cycle; their hierarchy was flattened");
      for (const c of pendingCats) c.parentId = null;
      continue;
    }
    for (const c of ready) {
      const [row] = await tx
        .insert(questionCategories)
        .values({ organizationId, courseId, parentId: c.parentId ? (qCatMap.get(c.parentId) ?? null) : null, name: c.name })
        .returning();
      qCatMap.set(c.id, row!.id);
      pendingCats.splice(pendingCats.indexOf(c), 1);
    }
  }
  const questionMap = new Map<string, string>();
  for (const q of backup.questionBank.questions) {
    let categoryId = qCatMap.get(q.categoryId);
    if (!categoryId) {
      const [row] = await tx.insert(questionCategories).values({ organizationId, courseId, name: "Restored questions" }).returning();
      categoryId = row!.id;
      qCatMap.set(q.categoryId, categoryId);
    }
    const valid = [];
    for (const v of q.versions) {
      const type = v.type as QuestionType;
      if (!(QUESTION_TYPES as readonly string[]).includes(type) || !DATA_SCHEMAS[type].safeParse(v.data).success) {
        warn(`Question "${v.name}" version ${v.version} has invalid data and was skipped`);
        continue;
      }
      valid.push({ ...v, type });
    }
    if (!valid.length) continue;
    const latest = Math.max(...valid.map((v) => v.version));
    const [row] = await tx.insert(questions).values({ organizationId, categoryId, latestVersion: latest, createdBy: userId }).returning();
    for (const v of valid) {
      await tx.insert(questionVersions).values({
        organizationId,
        questionId: row!.id,
        version: v.version,
        type: v.type,
        name: v.name.slice(0, 255),
        text: (await html(v.text, ctx.id)) ?? "",
        defaultMark: v.defaultMark,
        data: v.data,
        generalFeedback: await html(v.generalFeedback, ctx.id),
        createdBy: userId,
      });
    }
    questionMap.set(q.id, row!.id);
  }
  bump(report, "questions", questionMap.size);

  // ─── Certificate templates (reused when they exist in this organization) ──
  const templateMap = new Map<string, string>();
  for (const t of backup.certificateTemplates) {
    if (sameOrg) {
      const [same] = await tx.select({ id: certificateTemplates.id }).from(certificateTemplates).where(eq(certificateTemplates.id, t.id)).limit(1);
      if (same) {
        templateMap.set(t.id, same.id);
        continue;
      }
    }
    const [byName] = await tx.select({ id: certificateTemplates.id }).from(certificateTemplates).where(eq(certificateTemplates.name, t.name)).limit(1);
    if (byName) {
      templateMap.set(t.id, byName.id);
      continue;
    }
    const id = crypto.randomUUID();
    const tag = { component: "certificate", area: "template", itemId: id, contextId: system.id };
    const elements = [];
    for (const el of t.elements) {
      const parsed = zElement.safeParse(el);
      if (!parsed.success) continue;
      const e = { ...parsed.data };
      if (e.fileId) {
        const next = await restoreFile(e.fileId, tag);
        if (!next) {
          if (e.type === "image") continue;
          delete e.fileId;
        } else e.fileId = next;
      }
      elements.push(e);
    }
    await tx.insert(certificateTemplates).values({
      id,
      organizationId,
      name: t.name,
      orientation: t.orientation === "portrait" ? "portrait" : "landscape",
      backgroundFileId: await restoreFile(t.backgroundFileId, tag),
      elements,
    });
    templateMap.set(t.id, id);
    bump(report, "certificateTemplates");
  }

  // ─── Activities ────────────────────────────────────────────────────────────
  const activityMap = new Map<string, string>();
  const restored: ActivityRow[] = [];
  const positions = new Map<string, number>();
  const sortedActivities = [...backup.activities].sort(
    (a, b) => sortedSections.findIndex((s) => s.id === a.sectionId) - sortedSections.findIndex((s) => s.id === b.sectionId) || a.position - b.position,
  );
  for (const a of sortedActivities) {
    if (!(ACTIVITY_TYPES as readonly string[]).includes(a.type)) {
      report.unsupported.push(`Activity "${a.name}" of unknown type "${a.type}"`);
      continue;
    }
    const type = a.type as ActivityType;
    const kind = type === "page" || type === "url" || type === "file" ? "content" : type;
    const schema = TYPE_SCHEMAS[kind as keyof typeof TYPE_SCHEMAS];
    const parsed = schema.safeParse(a.data ?? {});
    if (!parsed.success) {
      warn(`Activity "${a.name}" (${type}) has invalid settings and was skipped`);
      continue;
    }
    if (kind === "certificate" && !templateMap.has((parsed.data as { templateId: string }).templateId)) {
      warn(`Certificate "${a.name}": its template was missing from the backup; the activity was skipped`);
      continue;
    }
    const sectionId = sectionMap.get(a.sectionId) ?? firstSectionId;
    const position = positions.get(sectionId) ?? 0;
    positions.set(sectionId, position + 1);
    const id = crypto.randomUUID();
    const actx = await createContext(tx, { organizationId, level: "activity", instanceId: id, parentId: ctx.id });
    let visible = a.visible;
    const [activity] = await tx
      .insert(activities)
      .values({
        id,
        organizationId,
        courseId,
        sectionId,
        contextId: actx.id,
        type,
        name: a.name.slice(0, 255),
        description: await html(a.description, actx.id),
        position,
        visible,
        availableFrom: toDate(a.availableFrom),
        availableUntil: toDate(a.availableUntil),
        completionRule: oneOf(COMPLETION_RULES, a.completionRule, "none"),
        groupMode: oneOf(GROUP_MODES, a.groupMode, "none"),
        createdBy: userId,
      })
      .returning();
    const base = { organizationId, activityId: id };
    const fileTag = (component: string, area: string) => ({ component, area, itemId: id, contextId: actx.id });
    const d = parsed.data as Record<string, unknown>;

    switch (kind) {
      case "content": {
        const s = d as z.infer<typeof TYPE_SCHEMAS.content>;
        const fileId = await restoreFile(s.fileId, fileTag("content", "resource"));
        if (type === "file" && !fileId) warn(`File resource "${a.name}" was restored without its file (files were not included)`);
        // url/file keep a small JSON options object in `content`; pages keep sanitized HTML.
        let content: string | null;
        let externalUrl: string | null = null;
        if (type === "page") content = (await html(s.content, actx.id)) ?? "";
        else if (type === "url") {
          content = JSON.stringify(parseOptions<UrlOptions>(s.content, { openInNewTab: true }));
          externalUrl = s.externalUrl ? normalizeExternalUrl(s.externalUrl) : null;
          if (!externalUrl) {
            visible = false;
            warn(`Link "${a.name}" has no valid URL: the activity was hidden`);
          }
        } else content = JSON.stringify(parseOptions<FileOptions>(s.content, { display: "inline" }));
        await tx.insert(contentResources).values({ ...base, content, externalUrl, fileId });
        break;
      }
      case "assignment": {
        const s = d as z.infer<typeof TYPE_SCHEMAS.assignment>;
        await tx.insert(assignments).values({ ...base, ...s, instructions: await html(s.instructions, actx.id), dueAt: s.dueAt ?? null, cutoffAt: s.cutoffAt ?? null, gradePass: s.gradePass ?? null });
        break;
      }
      case "quiz": {
        const { slots, ...s } = d as z.infer<typeof TYPE_SCHEMAS.quiz>;
        const [quiz] = await tx
          .insert(quizzes)
          .values({
            ...base,
            ...s,
            intro: await html(s.intro, actx.id),
            openAt: s.openAt ?? null,
            closeAt: s.closeAt ?? null,
            timeLimitSeconds: s.timeLimitSeconds ?? null,
            gradePass: s.gradePass ?? null,
          })
          .returning();
        let pos = 0;
        for (const slot of [...slots].sort((x, y) => x.position - y.position)) {
          const questionId = questionMap.get(slot.questionId);
          if (!questionId) {
            warn(`Quiz "${a.name}": a question was missing from the backup and was left out`);
            continue;
          }
          await tx.insert(quizSlots).values({ organizationId, quizId: quiz!.id, questionId, pinnedVersion: slot.pinnedVersion ?? null, position: pos++, maxMark: slot.maxMark });
          bump(report, "quizSlots");
        }
        break;
      }
      case "forum": {
        const s = d as z.infer<typeof TYPE_SCHEMAS.forum>;
        await tx.insert(forums).values({ ...base, ...s, intro: await html(s.intro, actx.id) });
        break;
      }
      case "workshop": {
        const s = d as z.infer<typeof TYPE_SCHEMAS.workshop>;
        await tx.insert(workshops).values({
          ...base,
          ...s,
          instructions: await html(s.instructions, actx.id),
          assessmentInstructions: await html(s.assessmentInstructions, actx.id),
          submissionEndAt: s.submissionEndAt ?? null,
          assessmentEndAt: s.assessmentEndAt ?? null,
        });
        break;
      }
      case "attendance": {
        const { sessions, ...s } = d as z.infer<typeof TYPE_SCHEMAS.attendance>;
        const [att] = await tx.insert(attendances).values({ ...base, ...s }).returning();
        for (const sess of sessions) {
          await tx.insert(attendanceSessions).values({
            organizationId,
            attendanceId: att!.id,
            groupId: sess.groupId ? (groupMap.get(sess.groupId) ?? null) : null,
            startsAt: sess.startsAt,
            durationMinutes: sess.durationMinutes,
            description: sess.description ? cleanHtml(sess.description) : null,
          });
        }
        bump(report, "attendanceSessions", sessions.length);
        break;
      }
      case "interactive": {
        const s = d as z.infer<typeof TYPE_SCHEMAS.interactive>;
        if (s.kind === "embed") {
          await tx.insert(interactiveContents).values({ ...base, kind: "embed", embedUrl: s.embedUrl ?? null, gradeMax: s.gradeMax, settings: {} });
          break;
        }
        const packageFileId = await restoreFile(s.packageFileId, fileTag("interactive", "package"));
        if (packageFileId) {
          // Unpack the package again for this activity through the type handler.
          await tx.insert(interactiveContents).values({ ...base, kind: "h5p", packageFileId, gradeMax: s.gradeMax, settings: {} });
          try {
            await activityType("interactive").update(tx, { organizationId, userId, activity: activity! }, {});
          } catch (err) {
            warn(`H5P package of "${a.name}" could not be installed: ${(err as Error).message}`);
          }
        } else if (sameOrg && s.packageFileId && (await fileExists(tx, s.packageFileId))) {
          // Same organization: the extracted package is still in storage.
          await tx.insert(interactiveContents).values({ ...base, kind: "h5p", packageFileId: s.packageFileId, gradeMax: s.gradeMax, settings: s.settings });
        } else {
          await tx.insert(interactiveContents).values({ ...base, kind: "h5p", packageFileId: null, gradeMax: s.gradeMax, settings: {} });
          visible = false;
          warn(`"${a.name}": the H5P package was not included; the activity was hidden until you upload it again`);
        }
        break;
      }
      case "video": {
        const s = d as z.infer<typeof TYPE_SCHEMAS.video>;
        await tx.insert(videoMeetings).values({ ...base, ...s, roomName: s.roomName ?? null, joinUrl: s.joinUrl ?? null, recordingUrl: s.recordingUrl ?? null });
        break;
      }
      case "certificate": {
        const s = d as z.infer<typeof TYPE_SCHEMAS.certificate>;
        const templateId = templateMap.get(s.templateId)!;
        await tx.insert(certificateActivities).values({ ...base, ...s, templateId, minGradePercent: s.minGradePercent ?? null, expiresAfterDays: s.expiresAfterDays ?? null });
        break;
      }
      case "lti": {
        const s = d as z.infer<typeof TYPE_SCHEMAS.lti>;
        let tool: { id: string } | undefined;
        if (sameOrg && s.toolId) [tool] = await tx.select({ id: ltiTools.id }).from(ltiTools).where(eq(ltiTools.id, s.toolId)).limit(1);
        if (!tool && s.toolName) [tool] = await tx.select({ id: ltiTools.id }).from(ltiTools).where(eq(ltiTools.name, s.toolName)).limit(1);
        if (tool) {
          await tx.insert(ltiLinks).values({ ...base, toolId: tool.id, targetLinkUri: s.targetLinkUri ?? null, customParams: s.customParams, gradeMax: s.gradeMax ?? null, openInNewWindow: s.openInNewWindow });
        } else {
          visible = false;
          warn(`External tool "${s.toolName ?? "?"}" was not found for "${a.name}": the activity was created hidden. Register the tool and edit the activity.`);
        }
        break;
      }
      case "scorm": {
        const s = d as z.infer<typeof TYPE_SCHEMAS.scorm>;
        let packageFileId = await restoreFile(s.packageFileId, fileTag("scorm", "package"));
        if (!packageFileId && sameOrg && s.packageFileId && (await fileExists(tx, s.packageFileId))) packageFileId = s.packageFileId;
        if (!sameOrg) {
          visible = false;
          warn(`SCORM package "${a.name}" comes from another organization: upload the package again (the activity was hidden)`);
        }
        await tx.insert(scormPackages).values({ ...base, ...s, title: s.title ?? null, packageFileId });
        break;
      }
    }
    if (!visible && activity!.visible) await tx.update(activities).set({ visible: false }).where(eq(activities.id, id));
    activityMap.set(a.id, id);
    restored.push({ ...activity!, visible });
    bump(report, "activities");
    bump(report, `activities.${type}`);
  }

  // ─── Gradebook setup ───────────────────────────────────────────────────────
  const gradeCatMap = new Map<string, string>();
  const srcRoot = backup.gradebook.categories.find((c) => !c.parentId);
  if (srcRoot) {
    gradeCatMap.set(srcRoot.id, root.id);
    await tx
      .update(gradeCategories)
      .set({ name: srcRoot.name, aggregation: oneOf(AGGREGATIONS, srcRoot.aggregation, "weighted_mean"), dropLowest: srcRoot.dropLowest })
      .where(eq(gradeCategories.id, root.id));
  }
  const pendingGc = backup.gradebook.categories.filter((c) => c !== srcRoot);
  while (pendingGc.length) {
    const ready = pendingGc.filter((c) => !c.parentId || gradeCatMap.has(c.parentId) || !backup.gradebook.categories.some((x) => x.id === c.parentId));
    if (!ready.length) {
      warn("Grade categories contain a cycle; they were attached to the course root");
      for (const c of pendingGc) c.parentId = null;
      continue;
    }
    for (const c of ready) {
      const [row] = await tx
        .insert(gradeCategories)
        .values({
          organizationId,
          courseId,
          parentId: (c.parentId && gradeCatMap.get(c.parentId)) || root.id,
          name: c.name,
          aggregation: oneOf(AGGREGATIONS, c.aggregation, "weighted_mean"),
          dropLowest: c.dropLowest,
        })
        .returning();
      gradeCatMap.set(c.id, row!.id);
      pendingGc.splice(pendingGc.indexOf(c), 1);
    }
  }
  const itemMap = new Map<string, string>();
  for (const it of backup.gradebook.items) {
    const categoryId = it.categoryId ? (gradeCatMap.get(it.categoryId) ?? root.id) : root.id;
    const values = {
      name: it.name.slice(0, 255),
      gradeMax: it.gradeMax,
      gradeMin: it.gradeMin,
      gradePass: it.gradePass,
      weight: it.weight,
      hidden: it.hidden,
      locked: it.locked,
      position: it.position,
    };
    if (it.type === "course") {
      const [total] = await tx.update(gradeItems).set(values).where(and(eq(gradeItems.courseId, courseId), eq(gradeItems.type, "course"))).returning();
      if (total) itemMap.set(it.id, total.id);
      continue;
    }
    if (it.type === "activity") {
      const activityId = it.activityId ? activityMap.get(it.activityId) : undefined;
      if (!activityId) continue;
      const act = restored.find((r) => r.id === activityId);
      const [row] = await tx
        .insert(gradeItems)
        .values({ organizationId, courseId, categoryId, type: "activity", activityId, ...values, hidden: values.hidden || (act ? !act.visible : false) })
        .returning();
      itemMap.set(it.id, row!.id);
    } else if (it.type === "manual" || it.type === "category") {
      const [row] = await tx.insert(gradeItems).values({ organizationId, courseId, categoryId, type: it.type, activityId: null, ...values }).returning();
      itemMap.set(it.id, row!.id);
    }
  }
  bump(report, "gradeItems", itemMap.size);
  // Gradable activities without a grade item in the backup (e.g. Moodle imports) get one now.
  const withItem = new Set(
    restored.length
      ? (await tx.select({ id: gradeItems.activityId }).from(gradeItems).where(inArray(gradeItems.activityId, restored.map((r) => r.id)))).map((r) => r.id)
      : [],
  );
  for (const act of restored) {
    if (withItem.has(act.id)) continue;
    try {
      const handler = activityType(act.type);
      if (handler.grading) await syncActivityGradeItem(tx, act, await handler.grading(tx, act));
    } catch {
      // Type not registered in this deployment: no grade item.
    }
  }

  // ─── Badges ────────────────────────────────────────────────────────────────
  for (const b of backup.badges) {
    const id = crypto.randomUUID();
    const c = b.criteria as { type?: string; activityIds?: string[] };
    let criteria: Record<string, unknown>;
    if (c.type === "course_completion") criteria = { type: "course_completion", courseId };
    else if (c.type === "activities") {
      const mapped = (c.activityIds ?? []).map((x) => activityMap.get(x)).filter((x): x is string => !!x);
      if (!mapped.length) {
        warn(`Badge "${b.name}": none of its activities were restored; it was changed to manual`);
        criteria = { type: "manual" };
      } else criteria = { type: "activities", activityIds: mapped };
    } else criteria = { type: "manual" };
    await tx.insert(badges).values({
      id,
      organizationId,
      courseId,
      name: b.name,
      description: b.description,
      imageFileId: await restoreFile(b.imageFileId, { component: "badge", area: "image", itemId: id, contextId: ctx.id }),
      criteria: criteria as typeof badges.$inferInsert.criteria,
      status: b.status === "inactive" ? "inactive" : "active",
      expiresAfterDays: b.expiresAfterDays,
      createdBy: userId,
    });
    bump(report, "badges");
  }

  // ─── Enrolments (only users that exist by email in this organization) ─────
  const enrolled: string[] = [];
  if (input.restoreEnrolments && backup.userData) {
    const emailOf = new Map(backup.userData.users.map((u) => [u.id, u.email.toLowerCase()]));
    const emails = [...new Set(emailOf.values())];
    const local = emails.length
      ? await tx
          .select({ id: users.id, email: users.email })
          .from(users)
          .where(and(inArray(sql`lower(${users.email})`, emails), isNull(users.deletedAt)))
      : [];
    const localByEmail = new Map(local.map((u) => [u.email.toLowerCase(), u.id]));
    let skipped = 0;
    for (const e of backup.userData.enrolments) {
      const localId = localByEmail.get(emailOf.get(e.userId) ?? "");
      if (!localId) {
        skipped++;
        continue;
      }
      if (localId === userId) continue;
      const role = (["editing_teacher", "teacher", "student", "guest"] as const).find((r) => e.roles.includes(r)) ?? "student";
      if (!(ENROLABLE_ROLES as readonly string[]).includes(role)) continue;
      const created = await enrolUser(tx, { organizationId, course: course!, userId: localId, method: "manual", role: role as EnrolRole, timeEnd: toDate(e.timeEnd), assignedBy: userId });
      if (created) enrolled.push(localId);
      bump(report, "enrolments");
    }
    if (skipped) warn(`${skipped} enrolment(s) were skipped: no user with that email in this organization`);
  } else if (backup.userData) {
    report.unsupported.push("User data (grades, submissions, forum posts) is not restored into a new course");
  }

  await emitInTx(tx, "course.created", { organizationId, courseId, userId });
  for (const act of restored) await emitInTx(tx, "activity.created", { organizationId, activityId: act.id, courseId, type: act.type, userId });
  for (const u of enrolled) await emitInTx(tx, "user.enrolled", { organizationId, userId: u, courseId });

  return { course: course!, activityMap, questionMap };
}

async function fileExists(tx: DB, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  const [f] = await tx.select({ id: files.id }).from(files).where(and(eq(files.id, id), isNull(files.deletedAt))).limit(1);
  return !!f;
}
