import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  activities,
  certificateActivities,
  certificateTemplates,
  courseCompletions,
  courses,
  files,
  gradeGrades,
  gradeItems,
  issuedCertificates,
  organizations,
  users,
  withTenant,
  type CertificateElement,
  type DB,
} from "@lms/db";
import { z } from "zod";
import { config } from "../../config";
import { registerActivityType, type ActivityRow } from "../../core/activity-types";
import { verificationCode } from "../../core/crypto";
import { badRequest } from "../../core/errors";
import { emit, on } from "../../core/events";
import { readFileBody, registerFileAccess, storeBuffer, type FileRow } from "../../core/files";
import { enqueue } from "../../core/jobs";
import { logger } from "../../core/logger";
import { notify } from "../../core/notify";
import { hasCapability } from "../../core/rbac";
import { zId } from "../../core/schemas";
import { renderCertificatePdf, type ImageInput } from "./pdf";
import type { CertificateValues } from "./render";

export type TemplateRow = typeof certificateTemplates.$inferSelect;
export type CertActivityRow = typeof certificateActivities.$inferSelect;
export type IssuedRow = typeof issuedCertificates.$inferSelect;

export const verifyUrlFor = (code: string) => `${config.APP_URL}/verify/${encodeURIComponent(code)}`;

// ─── Templates ──────────────────────────────────────────────────────────────

export const zElement = z
  .object({
    type: z.enum(["text", "image", "qrcode"]),
    x: z.number().min(0).max(297),
    y: z.number().min(0).max(297),
    width: z.number().min(1).max(297).optional(),
    fontSize: z.number().min(4).max(200).optional(),
    color: z
      .string()
      .regex(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)
      .optional(),
    align: z.enum(["left", "center", "right"]).optional(),
    text: z.string().max(2000).optional(),
    fileId: zId.optional(),
  })
  .refine((e) => e.type !== "image" || !!e.fileId, { message: "Image elements need an image file", path: ["fileId"] });

export const zTemplateInput = z.object({
  name: z.string().trim().min(1).max(255),
  orientation: z.enum(["landscape", "portrait"]).default("landscape"),
  backgroundFileId: zId.nullable().optional(),
  elements: z.array(zElement).max(60).default([]),
});

export const SAMPLE_VALUES: CertificateValues = {
  fullname: "Alex Example",
  coursename: "Sample Course",
  date: formatIssueDate(new Date()),
  code: "ABCD-EFGH-JKLM",
  grade: "92%",
  orgname: "Your Organization",
};

export function formatIssueDate(d: Date) {
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

function templateFileIds(t: { backgroundFileId?: string | null; elements: CertificateElement[] }) {
  return [...new Set([t.backgroundFileId, ...t.elements.filter((e) => e.type === "image").map((e) => e.fileId)].filter((x): x is string => !!x))];
}

/**
 * Files used by a template must be PNG/JPEG images that the editor uploaded or
 * that already belong to this template; they are re-tagged to the template.
 */
export async function attachTemplateFiles(
  tx: DB,
  input: { userId: string; templateId: string; systemContextId: string; backgroundFileId?: string | null; elements: CertificateElement[] },
) {
  const ids = templateFileIds(input);
  if (!ids.length) return;
  const rows = await tx.select().from(files).where(inArray(files.id, ids));
  for (const id of ids) {
    const f = rows.find((r) => r.id === id);
    const ownTemplateFile = f && f.component === "certificate" && f.area === "template";
    const ownUpload = f && f.ownerId === input.userId;
    if (!f || f.status !== "ready" || f.deletedAt || !(ownTemplateFile || ownUpload)) throw badRequest(`Invalid file ${id}`);
    if (!/^image\/(png|jpeg)$/.test(f.mimeType)) throw badRequest("Certificate images must be PNG or JPEG");
  }
  // Images shared between templates keep their first owner tag; new uploads get tagged to this template.
  const toTag = rows.filter((r) => !(r.component === "certificate" && r.area === "template")).map((r) => r.id);
  if (toTag.length) {
    await tx
      .update(files)
      .set({ component: "certificate", area: "template", itemId: input.templateId, contextId: input.systemContextId })
      .where(inArray(files.id, toTag));
  }
}

/** Loads template images (only certificate-template files or the editor's own uploads, for previews). */
async function loadImages(tx: DB, organizationId: string, ids: string[], userId?: string) {
  const out = new Map<string, ImageInput>();
  if (!ids.length) return out;
  const rows = await tx
    .select()
    .from(files)
    .where(and(inArray(files.id, ids), isNull(files.deletedAt)));
  for (const f of rows) {
    const allowed = (f.component === "certificate" && f.area === "template") || (userId && f.ownerId === userId);
    if (!allowed || f.status !== "ready" || !/^image\/(png|jpeg)$/.test(f.mimeType)) continue;
    try {
      out.set(f.id, { bytes: await readFileBody(tx, organizationId, f as FileRow), mimeType: f.mimeType });
    } catch (err) {
      logger.warn({ err, fileId: f.id }, "certificate image could not be read");
    }
  }
  return out;
}

export async function renderTemplate(
  tx: DB,
  organizationId: string,
  t: { orientation: string; backgroundFileId?: string | null; elements: CertificateElement[] },
  values: CertificateValues,
  opts: { previewUserId?: string; title?: string } = {},
) {
  const images = await loadImages(tx, organizationId, templateFileIds(t), opts.previewUserId);
  return renderCertificatePdf({
    orientation: t.orientation,
    elements: t.elements,
    background: t.backgroundFileId ? (images.get(t.backgroundFileId) ?? null) : null,
    images,
    values,
    verifyUrl: verifyUrlFor(values.code),
    title: opts.title,
  });
}

// ─── Eligibility ────────────────────────────────────────────────────────────

/**
 * Course grade as a percentage: the course-total item if the gradebook computed it,
 * otherwise the weighted mean of graded, visible activity items.
 */
export async function courseGradePercent(tx: DB, courseId: string, userId: string): Promise<number | null> {
  const rows = await tx
    .select({ type: gradeItems.type, gradeMax: gradeItems.gradeMax, gradeMin: gradeItems.gradeMin, weight: gradeItems.weight, hidden: gradeItems.hidden, finalGrade: gradeGrades.finalGrade })
    .from(gradeItems)
    .innerJoin(gradeGrades, and(eq(gradeGrades.itemId, gradeItems.id), eq(gradeGrades.userId, userId)))
    .where(eq(gradeItems.courseId, courseId));
  const total = rows.find((r) => r.type === "course" && r.finalGrade !== null);
  if (total && total.gradeMax > total.gradeMin) return ((total.finalGrade! - total.gradeMin) / (total.gradeMax - total.gradeMin)) * 100;
  let sum = 0;
  let weights = 0;
  for (const r of rows) {
    if (r.type === "course" || r.hidden || r.finalGrade === null || r.gradeMax <= r.gradeMin || r.weight <= 0) continue;
    sum += ((r.finalGrade - r.gradeMin) / (r.gradeMax - r.gradeMin)) * r.weight;
    weights += r.weight;
  }
  return weights > 0 ? (sum / weights) * 100 : null;
}

export type Eligibility = { eligible: boolean; courseCompleted: boolean; gradePercent: number | null; reasons: string[] };

export async function checkEligibility(tx: DB, cert: CertActivityRow, courseId: string, userId: string): Promise<Eligibility> {
  const [completion] = await tx
    .select({ id: courseCompletions.id })
    .from(courseCompletions)
    .where(and(eq(courseCompletions.courseId, courseId), eq(courseCompletions.userId, userId)))
    .limit(1);
  const gradePercent = await courseGradePercent(tx, courseId, userId);
  const reasons: string[] = [];
  if (cert.requireCourseCompletion && !completion) reasons.push("Complete the course first.");
  if (cert.minGradePercent !== null && cert.minGradePercent > 0 && (gradePercent === null || gradePercent + 1e-9 < cert.minGradePercent)) {
    reasons.push(`A course grade of at least ${cert.minGradePercent}% is required.`);
  }
  return { eligible: reasons.length === 0, courseCompleted: !!completion, gradePercent, reasons };
}

// ─── Issuing ────────────────────────────────────────────────────────────────

async function uniqueCode(tx: DB) {
  for (let i = 0; i < 6; i++) {
    const code = verificationCode();
    const [hit] = await tx.select({ id: issuedCertificates.id }).from(issuedCertificates).where(eq(issuedCertificates.code, code)).limit(1);
    if (!hit) return code;
  }
  throw new Error("Could not generate a unique certificate code");
}

export async function certActivityOf(tx: DB, activityId: string) {
  const [row] = await tx.select().from(certificateActivities).where(eq(certificateActivities.activityId, activityId)).limit(1);
  return row ?? null;
}

async function orgName(tx: DB, organizationId: string) {
  const [org] = await tx.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, organizationId)).limit(1);
  return org?.name ?? "";
}

/**
 * Issues (or re-issues a revoked) certificate: snapshots the values, renders and
 * stores the PDF, and notifies the learner. Returns null when it already exists.
 * The caller emits `certificate.issued` after commit.
 */
export async function issueCertificate(
  tx: DB,
  input: { activity: ActivityRow; cert: CertActivityRow; userId: string; organizationName?: string; reinstate?: boolean },
): Promise<IssuedRow | null> {
  const { activity, cert, userId } = input;
  const [existing] = await tx
    .select()
    .from(issuedCertificates)
    .where(and(eq(issuedCertificates.certificateActivityId, cert.id), eq(issuedCertificates.userId, userId)))
    .limit(1);
  if (existing && !(existing.revokedAt && input.reinstate)) return null;

  const [template] = await tx.select().from(certificateTemplates).where(eq(certificateTemplates.id, cert.templateId)).limit(1);
  if (!template) throw badRequest("The certificate template no longer exists");
  const [user] = await tx.select({ firstName: users.firstName, lastName: users.lastName }).from(users).where(eq(users.id, userId)).limit(1);
  const [course] = await tx.select({ fullname: courses.fullname }).from(courses).where(eq(courses.id, activity.courseId)).limit(1);
  if (!user || !course) throw badRequest("User or course not found");

  const now = new Date();
  const code = existing?.code ?? (await uniqueCode(tx));
  const grade = await courseGradePercent(tx, activity.courseId, userId);
  const values: CertificateValues = {
    fullname: `${user.firstName} ${user.lastName}`.trim(),
    coursename: course.fullname,
    date: formatIssueDate(now),
    code,
    grade: grade === null ? "" : `${Math.round(grade * 10) / 10}%`,
    orgname: input.organizationName ?? (await orgName(tx, activity.organizationId)),
  };
  const expiresAt = cert.expiresAfterDays ? new Date(now.getTime() + cert.expiresAfterDays * 86_400_000) : null;

  const id = existing?.id ?? crypto.randomUUID();
  const pdf = await renderTemplate(tx, activity.organizationId, template, values, { title: `${activity.name} — ${values.fullname}` });
  const file = await storeBuffer(tx, activity.organizationId, {
    component: "certificate",
    area: "issued",
    itemId: id,
    contextId: activity.contextId,
    ownerId: userId,
    filename: `certificate-${code}.pdf`,
    mimeType: "application/pdf",
    body: pdf,
  });

  let row: IssuedRow;
  if (existing) {
    if (existing.fileId) await tx.update(files).set({ deletedAt: now }).where(eq(files.id, existing.fileId));
    [row] = (await tx
      .update(issuedCertificates)
      .set({ revokedAt: null, issuedAt: now, expiresAt, snapshot: values, fileId: file.id })
      .where(eq(issuedCertificates.id, existing.id))
      .returning()) as [IssuedRow];
  } else {
    [row] = (await tx
      .insert(issuedCertificates)
      .values({
        id,
        organizationId: activity.organizationId,
        certificateActivityId: cert.id,
        userId,
        courseId: activity.courseId,
        code,
        fileId: file.id,
        snapshot: values,
        issuedAt: now,
        expiresAt,
      })
      .returning()) as [IssuedRow];
  }

  await notify(tx, {
    organizationId: activity.organizationId,
    userIds: [userId],
    type: "certificate_issued",
    title: `You earned a certificate: ${activity.name}`,
    body: `Your certificate for ${course.fullname} is ready to download.`,
    link: `/activities/${activity.id}`,
  });
  return row;
}

export function certificateStatus(row: Pick<IssuedRow, "revokedAt" | "expiresAt">, now = new Date()) {
  if (row.revokedAt) return "revoked" as const;
  if (row.expiresAt && row.expiresAt < now) return "expired" as const;
  return "valid" as const;
}

/** Background job for `course.completed`: auto-issue every eligible certificate activity in the course. */
async function autoIssueForCourse(organizationId: string, courseId: string, userId: string) {
  const issued = await withTenant(organizationId, async (tx) => {
    const rows = await tx
      .select({ activity: activities, cert: certificateActivities })
      .from(certificateActivities)
      .innerJoin(activities, eq(activities.id, certificateActivities.activityId))
      .where(and(eq(activities.courseId, courseId), eq(certificateActivities.autoIssue, true), eq(activities.visible, true)));
    const out: { row: IssuedRow; activity: ActivityRow }[] = [];
    if (!rows.length) return out;
    const name = await orgName(tx, organizationId);
    for (const { activity, cert } of rows) {
      const now = new Date();
      if ((activity.availableFrom && activity.availableFrom > now) || (activity.availableUntil && activity.availableUntil < now)) continue;
      const elig = await checkEligibility(tx, cert, courseId, userId);
      if (!elig.eligible) continue;
      const row = await issueCertificate(tx, { activity, cert, userId, organizationName: name });
      if (row) out.push({ row, activity });
    }
    return out;
  });
  for (const { row, activity } of issued) {
    await emit("certificate.issued", { organizationId, courseId, userId, activityId: activity.id, issuedCertificateId: row.id });
  }
}

// ─── Activity type ──────────────────────────────────────────────────────────

const settings = z.object({
  templateId: zId,
  requireCourseCompletion: z.boolean().default(true),
  minGradePercent: z.number().int().min(0).max(100).nullable().optional(),
  autoIssue: z.boolean().default(true),
  expiresAfterDays: z.number().int().min(1).max(36_500).nullable().optional(),
});

async function assertTemplate(tx: DB, templateId: string) {
  const [t] = await tx.select({ id: certificateTemplates.id }).from(certificateTemplates).where(eq(certificateTemplates.id, templateId)).limit(1);
  if (!t) throw badRequest("Choose a certificate template");
}

export function setupCertificate() {
  registerActivityType({
    type: "certificate",
    label: "Certificate",
    settings,
    async create(tx, { activity }, s) {
      await assertTemplate(tx, s.templateId);
      await tx.insert(certificateActivities).values({
        organizationId: activity.organizationId,
        activityId: activity.id,
        templateId: s.templateId,
        requireCourseCompletion: s.requireCourseCompletion ?? true,
        minGradePercent: s.minGradePercent ?? null,
        autoIssue: s.autoIssue ?? true,
        expiresAfterDays: s.expiresAfterDays ?? null,
      });
    },
    async update(tx, { activity }, s) {
      const row = await certActivityOf(tx, activity.id);
      if (!row) throw badRequest("Certificate settings are missing");
      if (s.templateId) await assertTemplate(tx, s.templateId);
      const patch = Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined));
      if (Object.keys(patch).length) await tx.update(certificateActivities).set(patch).where(eq(certificateActivities.id, row.id));
    },
    async load(tx, activity) {
      const row = await certActivityOf(tx, activity.id);
      if (!row) return null;
      const [t] = await tx.select({ name: certificateTemplates.name }).from(certificateTemplates).where(eq(certificateTemplates.id, row.templateId)).limit(1);
      return {
        templateId: row.templateId,
        templateName: t?.name ?? null,
        requireCourseCompletion: row.requireCourseCompletion,
        minGradePercent: row.minGradePercent,
        autoIssue: row.autoIssue,
        expiresAfterDays: row.expiresAfterDays,
      };
    },
  });

  registerFileAccess("certificate", async (tx, req, file) => {
    if (!file.contextId) return false;
    if (file.area === "template") return hasCapability(tx, req, "certificate:manage_templates", file.contextId);
    if (file.area === "issued") return hasCapability(tx, req, "certificate:view_issued", file.contextId);
    return false;
  });

  on("course.completed", async (_tx, p) => {
    // Rendering PDFs is slow: do it in a job (own transaction), then emit after commit.
    enqueue("certificate:auto-issue", () => autoIssueForCourse(p.organizationId, p.courseId, p.userId));
  });
}
