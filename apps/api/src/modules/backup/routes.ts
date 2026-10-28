import { and, desc, eq, inArray } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { FastifyRequest } from "fastify";
import { courseBackups, courseCategories, courses, files, getSystemContext, type DB } from "@lms/db";
import { z } from "zod";
import { requireUser } from "../../core/auth";
import { audit } from "../../core/audit";
import { badRequest, must, notFound } from "../../core/errors";
import { assertOwnFiles } from "../../core/files";
import { enqueueJob } from "../../core/jobs";
import { hasCapability, requireCapability } from "../../core/rbac";
import { zDate, zId, zNullableDate } from "../../core/schemas";
import { loadCourseWith } from "../courses/service";
import { MAX_ARCHIVE_BYTES } from "./format";
import type { BackupRow } from "./service";

const zBackup = z.object({
  id: zId,
  kind: z.enum(["backup", "restore"]),
  status: z.enum(["queued", "running", "done", "failed"]),
  courseId: zId.nullable(),
  course: z.object({ id: zId, fullname: z.string(), shortname: z.string() }).nullable(),
  fileId: zId.nullable(),
  file: z.object({ id: zId, filename: z.string(), size: z.number() }).nullable(),
  options: z.record(z.string(), z.unknown()),
  report: z.record(z.string(), z.unknown()),
  error: z.string().nullable(),
  createdBy: zId.nullable(),
  createdAt: zDate,
  finishedAt: zNullableDate,
});

async function present(tx: DB, rows: BackupRow[]) {
  const courseIds = [...new Set(rows.map((r) => r.courseId).filter((x): x is string => !!x))];
  const fileIds = [...new Set(rows.map((r) => r.fileId).filter((x): x is string => !!x))];
  const courseRows = courseIds.length
    ? await tx.select({ id: courses.id, fullname: courses.fullname, shortname: courses.shortname }).from(courses).where(inArray(courses.id, courseIds))
    : [];
  const fileRows = fileIds.length ? await tx.select({ id: files.id, filename: files.filename, size: files.size, deletedAt: files.deletedAt }).from(files).where(inArray(files.id, fileIds)) : [];
  const courseOf = new Map(courseRows.map((c) => [c.id, c]));
  const fileOf = new Map(fileRows.filter((f) => !f.deletedAt).map((f) => [f.id, { id: f.id, filename: f.filename, size: f.size }]));
  return rows.map((r) => ({
    ...r,
    course: r.courseId ? (courseOf.get(r.courseId) ?? null) : null,
    file: r.fileId ? (fileOf.get(r.fileId) ?? null) : null,
  }));
}

/** Who may see a backup/restore record. */
async function canSee(tx: DB, req: FastifyRequest, row: BackupRow) {
  const me = requireUser(req);
  const system = await getSystemContext(tx, req.org.id);
  if (await hasCapability(tx, req, "course:restore", system.id)) return true;
  if (row.kind === "backup") {
    if (!row.courseId) return row.createdBy === me.id;
    const [course] = await tx.select({ contextId: courses.contextId }).from(courses).where(eq(courses.id, row.courseId)).limit(1);
    return !!course && (await hasCapability(tx, req, "course:backup", course.contextId));
  }
  return row.createdBy === me.id;
}

export const routes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    "/courses/:courseId",
    {
      schema: {
        tags: ["Backup"],
        summary: "Back up a course (runs in the background; poll GET /backups/:id)",
        params: z.object({ courseId: zId }),
        body: z.object({ includeUserData: z.boolean().default(false), includeFiles: z.boolean().default(true) }),
        response: { 201: zBackup },
      },
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const me = requireUser(req);
      const out = await req.tenant(async (tx) => {
        const course = await loadCourseWith(tx, req, req.params.courseId, "course:backup");
        const [row] = await tx
          .insert(courseBackups)
          .values({ organizationId: req.org.id, kind: "backup", courseId: course.id, options: req.body, createdBy: me.id })
          .returning();
        await enqueueJob(tx, "backup.create", { backupId: row!.id }, { tenantId: req.org.id, uniqueKey: `backup:${row!.id}` });
        await audit(tx, req, "course.backup_requested", { type: "course", id: course.id }, req.body);
        return (await present(tx, [row!]))[0]!;
      });
      return reply.status(201).send(out);
    },
  );

  app.get(
    "/",
    {
      schema: {
        tags: ["Backup"],
        summary: "List backups of a course (courseId), or restores (without courseId)",
        querystring: z.object({ courseId: zId.optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }),
        response: { 200: z.array(zBackup) },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        const me = requireUser(req);
        if (req.query.courseId) {
          const course = await loadCourseWith(tx, req, req.query.courseId, "course:backup");
          const rows = await tx
            .select()
            .from(courseBackups)
            .where(and(eq(courseBackups.courseId, course.id), eq(courseBackups.kind, "backup")))
            .orderBy(desc(courseBackups.createdAt))
            .limit(req.query.limit);
          return present(tx, rows);
        }
        const system = await getSystemContext(tx, req.org.id);
        const all = await hasCapability(tx, req, "course:restore", system.id);
        const rows = await tx
          .select()
          .from(courseBackups)
          .where(and(eq(courseBackups.kind, "restore"), all ? undefined : eq(courseBackups.createdBy, me.id)))
          .orderBy(desc(courseBackups.createdAt))
          .limit(req.query.limit);
        return present(tx, rows);
      }),
  );

  app.get(
    "/:id",
    { schema: { tags: ["Backup"], summary: "A backup or restore with its status and report", params: z.object({ id: zId }), response: { 200: zBackup } } },
    (req) =>
      req.tenant(async (tx) => {
        const row = must((await tx.select().from(courseBackups).where(eq(courseBackups.id, req.params.id)).limit(1))[0], "Backup");
        if (!(await canSee(tx, req, row))) throw notFound("Backup");
        return (await present(tx, [row]))[0]!;
      }),
  );

  app.post(
    "/restore",
    {
      schema: {
        tags: ["Backup"],
        summary: "Restore a backup (.zip from this LMS, or a Moodle .mbz) into a NEW course",
        body: z.object({
          fileId: zId,
          categoryId: zId.nullable().optional(),
          fullname: z.string().trim().min(1).max(255).optional(),
          shortname: z.string().trim().min(1).max(100).optional(),
          /** Enrol users of the backup that exist (by email) in this organization. */
          restoreEnrolments: z.boolean().default(false),
        }),
        response: { 201: zBackup },
      },
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const me = requireUser(req);
      const out = await req.tenant(async (tx) => {
        let contextId = (await getSystemContext(tx, req.org.id)).id;
        if (req.body.categoryId) {
          const cat = must((await tx.select().from(courseCategories).where(eq(courseCategories.id, req.body.categoryId)).limit(1))[0], "Category");
          contextId = cat.contextId;
        }
        await requireCapability(tx, req, "course:restore", contextId);
        await requireCapability(tx, req, "course:create", contextId);
        await assertOwnFiles(tx, req, [req.body.fileId]);
        const [file] = await tx.select().from(files).where(eq(files.id, req.body.fileId)).limit(1);
        if (!file || file.size > MAX_ARCHIVE_BYTES) throw badRequest("The backup is too large to restore");
        if (!/\.(zip|mbz)$/i.test(file.filename)) throw badRequest("Upload a .zip backup or a Moodle .mbz file");
        const [row] = await tx
          .insert(courseBackups)
          .values({ organizationId: req.org.id, kind: "restore", fileId: file.id, options: { ...req.body }, createdBy: me.id })
          .returning();
        // A fresh upload now belongs to the restore record (no longer a draft). Existing backup archives keep their tags.
        if (file.component === "draft") {
          await tx.update(files).set({ component: "backup", area: "restore", itemId: row!.id, contextId }).where(eq(files.id, file.id));
        }
        await enqueueJob(tx, "backup.restore", { backupId: row!.id }, { tenantId: req.org.id, uniqueKey: `restore:${row!.id}` });
        await audit(tx, req, "course.restore_requested", { type: "backup", id: row!.id }, { filename: file.filename, categoryId: req.body.categoryId ?? null });
        return (await present(tx, [row!]))[0]!;
      });
      return reply.status(201).send(out);
    },
  );
};
