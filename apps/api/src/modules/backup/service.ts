import { eq } from "drizzle-orm";
import { courseBackups, courses, files, getSystemContext, withTenant, type DB } from "@lms/db";
import { defineJob } from "../../core/jobs";
import { readFileBody, registerFileAccess, storeBuffer } from "../../core/files";
import { logger } from "../../core/logger";
import { notify } from "../../core/notify";
import { hasCapability } from "../../core/rbac";
import { ArchiveError, readArchive } from "./archive";
import { buildCourseBackup } from "./export";
import { BACKUP_FORMAT, BACKUP_VERSION, MAX_ARCHIVE_BYTES, MAX_COURSE_JSON_BYTES, zBackupCourse, zManifest, type RestoreReport } from "./format";
import { isMoodleBackup, mbzFilter, parseMoodleBackup } from "./mbz";
import { restoreCourse } from "./restore";
import { XmlError } from "./xml";

export type BackupRow = typeof courseBackups.$inferSelect;
export type BackupJobPayload = { backupId: string };

/** Errors caused by the archive itself: reported to the user, never retried. */
export class BackupError extends Error {}

const MAX_ATTEMPTS = 3;

async function setStatus(tenantId: string, backupId: string, patch: Partial<typeof courseBackups.$inferInsert>) {
  await withTenant(tenantId, (tx) => tx.update(courseBackups).set(patch).where(eq(courseBackups.id, backupId)));
}

/** Claims a queued/running row; returns null when it was already finished (idempotent re-runs). */
async function begin(tenantId: string, backupId: string) {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx.select().from(courseBackups).where(eq(courseBackups.id, backupId)).limit(1);
    if (!row || row.status === "done" || row.status === "failed") return null;
    await tx.update(courseBackups).set({ status: "running", error: null }).where(eq(courseBackups.id, row.id));
    return row;
  });
}

async function fail(tenantId: string, row: BackupRow, err: unknown, attempt: number) {
  const known = err instanceof BackupError || err instanceof ArchiveError || err instanceof XmlError;
  const final = known || attempt >= MAX_ATTEMPTS;
  const message = known ? (err as Error).message : "Unexpected error while processing the backup";
  if (!known) logger.error({ err, backupId: row.id, kind: row.kind }, "backup job failed");
  await withTenant(tenantId, async (tx) => {
    await tx
      .update(courseBackups)
      .set({ status: final ? "failed" : "queued", error: message, finishedAt: final ? new Date() : null })
      .where(eq(courseBackups.id, row.id));
    if (final && row.createdBy) {
      await notify(tx, {
        organizationId: tenantId,
        userIds: [row.createdBy],
        type: "backup_ready",
        title: row.kind === "backup" ? "Course backup failed" : "Course restore failed",
        body: message,
        link: row.kind === "backup" && row.courseId ? `/courses/${row.courseId}/backup` : `/admin/restore?id=${row.id}`,
      });
    }
  });
  if (!final) throw err;
}

export async function runBackupJob(payload: BackupJobPayload, ctx: { tenantId: string | null; attempt: number }) {
  const tenantId = ctx.tenantId;
  if (!tenantId) throw new Error("backup.create needs a tenant");
  const row = await begin(tenantId, payload.backupId);
  if (!row) return;
  try {
    await withTenant(tenantId, async (tx) => {
      if (!row.courseId) throw new BackupError("The course no longer exists");
      const [course] = await tx.select().from(courses).where(eq(courses.id, row.courseId)).limit(1);
      if (!course) throw new BackupError("The course no longer exists");
      const opts = row.options as { includeUserData?: boolean; includeFiles?: boolean };
      const built = await buildCourseBackup(tx, {
        organizationId: tenantId,
        courseId: course.id,
        includeUserData: !!opts.includeUserData,
        includeFiles: opts.includeFiles !== false,
      });
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
      const file = await storeBuffer(tx, tenantId, {
        component: "backup",
        area: "archive",
        itemId: row.id,
        contextId: course.contextId,
        ownerId: row.createdBy,
        filename: `backup-${course.shortname.replace(/[^\w.-]+/g, "_")}-${stamp}.zip`,
        mimeType: "application/zip",
        body: built.zip,
      });
      await tx
        .update(courseBackups)
        .set({
          status: "done",
          fileId: file.id,
          error: null,
          finishedAt: new Date(),
          report: { counts: built.manifest.counts, warnings: built.warnings, size: built.zip.length } as Record<string, unknown>,
        })
        .where(eq(courseBackups.id, row.id));
      if (row.createdBy) {
        await notify(tx, {
          organizationId: tenantId,
          userIds: [row.createdBy],
          type: "backup_ready",
          title: `Backup of ${course.fullname} is ready`,
          link: `/courses/${course.id}/backup`,
        });
      }
    });
  } catch (err) {
    await fail(tenantId, row, err, ctx.attempt);
  }
}

/** Reads the uploaded archive and dispatches to the lms-backup or Moodle importer. */
async function loadArchive(tx: DB, tenantId: string, fileId: string, report: RestoreReport) {
  const [file] = await tx.select().from(files).where(eq(files.id, fileId)).limit(1);
  if (!file || file.deletedAt || file.status !== "ready") throw new BackupError("The uploaded backup file is missing");
  if (file.size > MAX_ARCHIVE_BYTES) throw new BackupError("The backup is too large to restore");
  const body = await readFileBody(tx, tenantId, file);
  if (body.length > MAX_ARCHIVE_BYTES) throw new BackupError("The backup is too large to restore");

  const head = readArchive(body, undefined, (n) => n === "manifest.json" || n === "moodle_backup.xml");
  if (head.has("manifest.json")) {
    let manifestRaw: unknown;
    try {
      manifestRaw = JSON.parse(head.get("manifest.json")!.toString("utf8"));
    } catch {
      throw new BackupError("manifest.json is not valid JSON");
    }
    const manifest = zManifest.safeParse(manifestRaw);
    if (!manifest.success) throw new BackupError(`Not an ${BACKUP_FORMAT} archive (invalid manifest)`);
    if (manifest.data.version > BACKUP_VERSION) {
      throw new BackupError(`This backup was made by a newer version (format ${manifest.data.version}); this site supports version ${BACKUP_VERSION}`);
    }
    const archive = readArchive(body);
    const courseJson = archive.get("course.json");
    if (!courseJson) throw new BackupError("course.json is missing from the backup");
    if (courseJson.length > MAX_COURSE_JSON_BYTES) throw new BackupError("course.json is too large");
    let raw: unknown;
    try {
      raw = JSON.parse(courseJson.toString("utf8"));
    } catch {
      throw new BackupError("course.json is not valid JSON");
    }
    const parsed = zBackupCourse.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new BackupError(`course.json is invalid${issue ? ` at ${issue.path.join(".")}: ${issue.message}` : ""}`);
    }
    report.source = {
      format: BACKUP_FORMAT,
      version: manifest.data.version,
      organization: manifest.data.source.organizationName,
      course: manifest.data.course.fullname,
    };
    return { backup: parsed.data, archive, sourceOrganizationId: manifest.data.source.organizationId };
  }
  if (head.has("moodle_backup.xml")) {
    const archive = readArchive(body, undefined, mbzFilter);
    if (!isMoodleBackup(archive)) throw new BackupError("moodle_backup.xml is missing");
    return { backup: parseMoodleBackup(archive, report), archive: new Map<string, Buffer>(), sourceOrganizationId: null };
  }
  throw new BackupError("This archive is neither an LMS backup nor a Moodle backup (.mbz)");
}

export async function runRestoreJob(payload: BackupJobPayload, ctx: { tenantId: string | null; attempt: number }) {
  const tenantId = ctx.tenantId;
  if (!tenantId) throw new Error("backup.restore needs a tenant");
  const row = await begin(tenantId, payload.backupId);
  if (!row) return;
  try {
    await withTenant(tenantId, async (tx) => {
      if (!row.fileId || !row.createdBy) throw new BackupError("The uploaded backup file is missing");
      const opts = row.options as { categoryId?: string | null; fullname?: string | null; shortname?: string | null; restoreEnrolments?: boolean };
      const report: RestoreReport = { counts: {}, warnings: [], unsupported: [] };
      const loaded = await loadArchive(tx, tenantId, row.fileId, report);
      const { course } = await restoreCourse(tx, {
        organizationId: tenantId,
        userId: row.createdBy,
        backup: loaded.backup,
        archive: loaded.archive,
        sourceOrganizationId: loaded.sourceOrganizationId,
        categoryId: opts.categoryId ?? null,
        fullname: opts.fullname ?? null,
        shortname: opts.shortname ?? null,
        restoreEnrolments: !!opts.restoreEnrolments,
        report,
      });
      await tx
        .update(courseBackups)
        .set({ status: "done", courseId: course.id, error: null, finishedAt: new Date(), report: report as unknown as Record<string, unknown> })
        .where(eq(courseBackups.id, row.id));
      await notify(tx, {
        organizationId: tenantId,
        userIds: [row.createdBy],
        type: "backup_ready",
        title: `Course restored: ${course.fullname}`,
        body: report.warnings.length ? `${report.warnings.length} warning(s) — see the restore report.` : undefined,
        link: `/courses/${course.id}`,
      });
    });
  } catch (err) {
    await fail(tenantId, row, err, ctx.attempt);
  }
}

export function setupBackup() {
  defineJob<BackupJobPayload>("backup.create", runBackupJob, { maxAttempts: MAX_ATTEMPTS, backoffSeconds: 30 });
  defineJob<BackupJobPayload>("backup.restore", runRestoreJob, { maxAttempts: MAX_ATTEMPTS, backoffSeconds: 30 });

  // Backup archives: course:backup in the course they came from, or course:restore at site level.
  registerFileAccess("backup", async (tx, req, file) => {
    if (!req.user) return false;
    if (file.contextId && file.area === "archive" && (await hasCapability(tx, req, "course:backup", file.contextId))) return true;
    const system = await getSystemContext(tx, req.org.id);
    return hasCapability(tx, req, "course:restore", system.id);
  });
}
