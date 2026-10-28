import { and, asc, eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { files, scormAttempts, scormPackages, type DB } from "@lms/db";
import { z } from "zod";
import { registerActivityType, type ActivityRow } from "../../core/activity-types";
import { hmac, safeEqual } from "../../core/crypto";
import { badRequest } from "../../core/errors";
import { assertOwnFiles, queuePackageCleanup, readFileBody, registerFileAccess } from "../../core/files";
import { hasCapability } from "../../core/rbac";
import { zId } from "../../core/schemas";
import { storageFor } from "../../core/storage";
import { listZip, readZipEntry, safeEntryPath, ZipError, type ZipEntry } from "../interactive/zip";
import { aggregateGrade, GRADE_METHODS, ratioOf, type GradeMethod, type PackageRules } from "./cmi";
import { ManifestError, parseManifest, splitHref, type ManifestInfo } from "./manifest";

export type PackageRow = typeof scormPackages.$inferSelect;
export type AttemptRow = typeof scormAttempts.$inferSelect;

/** Same limits as H5P: largest package we unpack (the generic upload limit is 200 MB). */
const MAX_PACKAGE_BYTES = 150 * 1024 * 1024;
export const CONTENT_TOKEN_TTL_SECONDS = 6 * 60 * 60;

export async function packageOf(tx: DB, activityId: string) {
  const [row] = await tx.select().from(scormPackages).where(eq(scormPackages.activityId, activityId)).limit(1);
  return row ?? null;
}

export const manifestOf = (pkg: PackageRow) => pkg.manifest as Partial<ManifestInfo>;

export function packageRules(pkg: PackageRow): PackageRules {
  const m = manifestOf(pkg);
  return { masteryScore: m.masteryScore ?? null, scaledPassingScore: m.scaledPassingScore ?? null, completionThreshold: m.completionThreshold ?? null };
}

// ─── Package inspection (pure) ──────────────────────────────────────────────

export type PackageFile = { path: string; entry: ZipEntry };

/** Validates a SCORM zip: safe paths, imsmanifest.xml at the root, launch file present. */
export function inspectScorm(zip: Buffer): { manifest: ManifestInfo; files: PackageFile[] } {
  let entries: ZipEntry[];
  try {
    entries = listZip(zip);
  } catch (err) {
    throw new ManifestError(err instanceof ZipError ? err.message : "Invalid ZIP archive");
  }
  const out: PackageFile[] = [];
  for (const entry of entries) {
    const path = safeEntryPath(entry.name);
    if (!path) throw new ManifestError(`Unsafe path in package: ${entry.name.slice(0, 100)}`);
    if (path.split("/").some((p) => p === "__MACOSX" || p === ".DS_Store")) continue;
    out.push({ path, entry });
  }
  const manifestFile = out.find((f) => f.path === "imsmanifest.xml");
  if (!manifestFile) throw new ManifestError("Not a SCORM package: imsmanifest.xml is missing at the root of the zip");
  let xml: string;
  try {
    xml = readZipEntry(zip, manifestFile.entry).toString("utf8");
  } catch (err) {
    throw new ManifestError(err instanceof Error ? err.message : "Unreadable imsmanifest.xml");
  }
  const manifest = parseManifest(xml);
  const { path } = splitHref(manifest.entryHref);
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("//")) throw new ManifestError("External launch URLs are not supported");
  const safe = safeEntryPath(path);
  if (!safe || !out.some((f) => f.path === safe)) throw new ManifestError(`The launch file ${path.slice(0, 200)} is not in the package`);
  return { manifest, files: out };
}

/**
 * Re-tags the uploaded zip to the activity, unpacks it under
 * `<org>/scorm/<packageId>/<fileId>/` and returns what to store on the package row.
 */
async function installPackage(tx: DB, activity: ActivityRow, userId: string, packageId: string, fileId: string) {
  const [file] = await tx.select().from(files).where(eq(files.id, fileId)).limit(1);
  const alreadyAttached = file && file.component === "scorm" && file.itemId === activity.id;
  if (!alreadyAttached) await assertOwnFiles(tx, { user: { id: userId } } as unknown as FastifyRequest, [fileId]);
  if (!file || file.deletedAt) throw badRequest("Invalid package file");
  if (!/\.zip$/i.test(file.filename)) throw badRequest("Upload a SCORM .zip package");
  if (file.size > MAX_PACKAGE_BYTES) throw badRequest("SCORM package is too large (max 150 MB)");

  const body = await readFileBody(tx, activity.organizationId, file);
  let inspected: ReturnType<typeof inspectScorm>;
  try {
    inspected = inspectScorm(body);
  } catch (err) {
    throw badRequest(err instanceof ManifestError ? err.message : "Invalid SCORM package");
  }

  const driver = await storageFor(tx, activity.organizationId);
  const prefix = `${activity.organizationId}/scorm/${packageId}/${file.id}`;
  for (const f of inspected.files) {
    let bytes: Buffer;
    try {
      bytes = readZipEntry(body, f.entry);
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : "Corrupt SCORM package");
    }
    await driver.put(`${prefix}/${f.path}`, bytes, "application/octet-stream");
  }
  await tx
    .update(files)
    .set({ component: "scorm", area: "package", itemId: activity.id, contextId: activity.contextId })
    .where(eq(files.id, file.id));
  const { path, suffix } = splitHref(inspected.manifest.entryHref);
  return {
    version: inspected.manifest.version,
    entryHref: `${safeEntryPath(path)}${suffix}`,
    storagePrefix: prefix,
    title: inspected.manifest.title,
    manifest: { ...inspected.manifest, fileCount: inspected.files.length } as Record<string, unknown>,
  };
}

// ─── Signed content tokens ──────────────────────────────────────────────────

/**
 * Package files are served same-origin (the SCO must reach `window.parent.API`), under a
 * path containing an HMAC token bound to (user, activity, package prefix), valid 6 hours.
 * Format: `<userId>.<exp>.<sig>`. Relative URLs inside the package keep the token.
 */
function tokenPayload(userId: string, activityId: string, prefix: string, exp: number) {
  return `scorm:${userId}:${activityId}:${prefix}:${exp}`;
}

export function contentToken(userId: string, activityId: string, prefix: string, now = Date.now()) {
  const exp = Math.floor(now / 1000) + CONTENT_TOKEN_TTL_SECONDS;
  return `${userId}.${exp}.${hmac(tokenPayload(userId, activityId, prefix, exp))}`;
}

export function verifyContentToken(token: string, activityId: string, prefix: string, now = Date.now()): { userId: string } | null {
  const [userId, expRaw, sig] = token.split(".");
  const exp = Number(expRaw);
  if (!userId || !sig || !Number.isInteger(exp) || exp < now / 1000) return null;
  return safeEqual(sig, hmac(tokenPayload(userId, activityId, prefix, exp))) ? { userId } : null;
}

// ─── Grade aggregation ──────────────────────────────────────────────────────

export async function attemptsOf(tx: DB, packageId: string, userId: string) {
  return tx
    .select()
    .from(scormAttempts)
    .where(and(eq(scormAttempts.packageId, packageId), eq(scormAttempts.userId, userId)))
    .orderBy(asc(scormAttempts.attempt));
}

export function aggregateRatio(pkg: PackageRow, attempts: AttemptRow[]) {
  return aggregateGrade((GRADE_METHODS.includes(pkg.gradeMethod as GradeMethod) ? pkg.gradeMethod : "highest") as GradeMethod, attempts.map(ratioOf));
}

// ─── Activity type ──────────────────────────────────────────────────────────

const settings = z.object({
  packageFileId: zId,
  gradeMax: z.number().min(0).max(10_000).default(100),
  gradeMethod: z.enum(["highest", "average", "first", "last"]).default("highest"),
  /** 0 = unlimited. */
  maxAttempts: z.number().int().min(0).max(100).default(0),
});

export function setupScorm() {
  registerActivityType({
    type: "scorm",
    label: "SCORM package",
    settings,
    async create(tx, { activity, userId }, s) {
      const id = crypto.randomUUID();
      const installed = await installPackage(tx, activity, userId, id, s.packageFileId);
      await tx.insert(scormPackages).values({
        id,
        organizationId: activity.organizationId,
        activityId: activity.id,
        packageFileId: s.packageFileId,
        ...installed,
        gradeMax: s.gradeMax ?? 100,
        gradeMethod: s.gradeMethod ?? "highest",
        maxAttempts: s.maxAttempts ?? 0,
      });
    },
    async update(tx, { activity, userId }, s) {
      const pkg = await packageOf(tx, activity.id);
      if (!pkg) throw badRequest("SCORM package is missing");
      const patch: Partial<typeof scormPackages.$inferInsert> = {};
      if (s.packageFileId !== undefined && s.packageFileId !== pkg.packageFileId) {
        Object.assign(patch, await installPackage(tx, activity, userId, pkg.id, s.packageFileId));
        patch.packageFileId = s.packageFileId;
        if (pkg.storagePrefix !== patch.storagePrefix) await queuePackageCleanup(tx, activity.organizationId, pkg.storagePrefix);
      }
      if (s.gradeMax !== undefined) patch.gradeMax = s.gradeMax;
      if (s.gradeMethod !== undefined) patch.gradeMethod = s.gradeMethod;
      if (s.maxAttempts !== undefined) patch.maxAttempts = s.maxAttempts;
      if (Object.keys(patch).length) await tx.update(scormPackages).set(patch).where(eq(scormPackages.id, pkg.id));
    },
    async load(tx, activity) {
      const pkg = await packageOf(tx, activity.id);
      if (!pkg) return null;
      const m = manifestOf(pkg);
      return {
        packageFileId: pkg.packageFileId,
        version: pkg.version,
        title: pkg.title,
        gradeMax: pkg.gradeMax,
        gradeMethod: pkg.gradeMethod,
        maxAttempts: pkg.maxAttempts,
        scoCount: m.scoCount ?? 1,
        multiSco: m.multiSco ?? false,
      };
    },
    async grading(tx, activity) {
      const pkg = await packageOf(tx, activity.id);
      return { gradeMax: pkg?.gradeMax ?? 100, gradePass: null };
    },
  });

  // The raw zip is for editors only; learners use the player.
  registerFileAccess("scorm", async (tx, req, file) => !!file.contextId && (await hasCapability(tx, req, "activity:update", file.contextId)));
}
