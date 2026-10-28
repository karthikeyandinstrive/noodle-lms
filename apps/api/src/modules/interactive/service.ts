import { and, desc, eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { files, interactiveContents, interactiveResults, type DB } from "@lms/db";
import { z } from "zod";
import { registerActivityType, type ActivityRow } from "../../core/activity-types";
import { hmac, safeEqual } from "../../core/crypto";
import { badRequest } from "../../core/errors";
import { assertOwnFiles, queuePackageCleanup, readFileBody, registerFileAccess } from "../../core/files";
import { hasCapability } from "../../core/rbac";
import { zId } from "../../core/schemas";
import { storageFor } from "../../core/storage";
import { normalizeEmbedUrl } from "./embed";
import { H5pError, inspectH5p, type H5pMeta } from "./h5p";
import { readZipEntry } from "./zip";

export type InteractiveRow = typeof interactiveContents.$inferSelect;
type H5pInfo = H5pMeta & { prefix: string; fileCount: number };

/** Largest .h5p we unpack (the generic upload limit is 200 MB). */
const MAX_PACKAGE_BYTES = 150 * 1024 * 1024;
const TOKEN_TTL_SECONDS = 6 * 60 * 60;

export async function interactiveOf(tx: DB, activityId: string) {
  const [row] = await tx.select().from(interactiveContents).where(eq(interactiveContents.activityId, activityId)).limit(1);
  return row ?? null;
}

export function h5pInfo(row: InteractiveRow): H5pInfo | null {
  const h = row.settings?.h5p as H5pInfo | undefined;
  return h && typeof h.prefix === "string" ? h : null;
}

const asReq = (userId: string) => ({ user: { id: userId } }) as unknown as FastifyRequest;

/**
 * Validates an uploaded .h5p, re-tags it to the activity and unpacks the whitelisted
 * files into storage under a prefix unique to (content, package).
 */
async function installPackage(tx: DB, activity: ActivityRow, userId: string, interactiveId: string, fileId: string): Promise<H5pInfo> {
  const [file] = await tx.select().from(files).where(eq(files.id, fileId)).limit(1);
  const alreadyAttached = file && file.component === "interactive" && file.itemId === activity.id;
  if (!alreadyAttached) await assertOwnFiles(tx, asReq(userId), [fileId]);
  if (!file || file.deletedAt) throw badRequest("Invalid package file");
  if (!/\.h5p$/i.test(file.filename)) throw badRequest("Upload an .h5p file");
  if (file.size > MAX_PACKAGE_BYTES) throw badRequest("H5P package is too large (max 150 MB)");

  const body = await readFileBody(tx, activity.organizationId, file);
  let inspected: ReturnType<typeof inspectH5p>;
  try {
    inspected = inspectH5p(body);
  } catch (err) {
    throw badRequest(err instanceof H5pError ? err.message : "Invalid H5P package");
  }

  const driver = await storageFor(tx, activity.organizationId);
  const prefix = `${activity.organizationId}/interactive/h5p/${interactiveId}/${file.id}`;
  for (const f of inspected.files) {
    let bytes: Buffer;
    try {
      bytes = readZipEntry(body, f.entry);
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : "Corrupt H5P package");
    }
    await driver.put(`${prefix}/${f.path}`, bytes, "application/octet-stream");
  }

  await tx
    .update(files)
    .set({ component: "interactive", area: "package", itemId: activity.id, contextId: activity.contextId })
    .where(eq(files.id, file.id));
  return { ...inspected.meta, prefix, fileCount: inspected.files.length };
}

function resolveEmbed(url: string | null | undefined) {
  if (!url) throw badRequest("An embed URL is required");
  const n = normalizeEmbedUrl(url);
  if (!n) throw badRequest("This URL is not allowed. Use YouTube, Vimeo, H5P.com, Google Docs/Slides/Forms or Loom.");
  return n.url;
}

// ─── Signed package tokens (the sandboxed player has no cookies) ────────────

function tokenPayload(activityId: string, prefix: string, exp: number) {
  return `h5p:${activityId}:${prefix}:${exp}`;
}

export function packageToken(activityId: string, prefix: string, now = Date.now()) {
  const exp = Math.floor(now / 1000) + TOKEN_TTL_SECONDS;
  return `${exp}.${hmac(tokenPayload(activityId, prefix, exp))}`;
}

export function verifyPackageToken(activityId: string, prefix: string, token: string) {
  const [expRaw, sig] = token.split(".");
  const exp = Number(expRaw);
  if (!sig || !Number.isInteger(exp) || exp < Date.now() / 1000) return false;
  return safeEqual(sig, hmac(tokenPayload(activityId, prefix, exp)));
}

// ─── Results ────────────────────────────────────────────────────────────────

export async function bestRatio(tx: DB, interactiveId: string, userId: string) {
  const rows = await tx
    .select({ raw: interactiveResults.rawScore, max: interactiveResults.maxScore })
    .from(interactiveResults)
    .where(and(eq(interactiveResults.interactiveId, interactiveId), eq(interactiveResults.userId, userId)))
    .orderBy(desc(interactiveResults.createdAt));
  let best: number | null = null;
  for (const r of rows) {
    if (r.raw === null || r.max === null || r.max <= 0) continue;
    const ratio = Math.max(0, Math.min(1, r.raw / r.max));
    if (best === null || ratio > best) best = ratio;
  }
  return best;
}

// ─── Activity type registration ─────────────────────────────────────────────

const settings = z.object({
  kind: z.enum(["h5p", "embed"]).default("embed"),
  embedUrl: z.string().trim().max(2000).nullable().optional(),
  packageFileId: zId.nullable().optional(),
  gradeMax: z.number().min(0).max(10_000).default(100),
});

export function setupInteractive() {
  registerActivityType({
    type: "interactive",
    label: "Interactive content",
    settings,
    async create(tx, { activity, userId }, s) {
      const id = crypto.randomUUID();
      const kind = s.kind ?? "embed";
      let embedUrl: string | null = null;
      let h5p: H5pInfo | null = null;
      if (kind === "embed") embedUrl = resolveEmbed(s.embedUrl);
      else {
        if (!s.packageFileId) throw badRequest("Upload an H5P package");
        h5p = await installPackage(tx, activity, userId, id, s.packageFileId);
      }
      await tx.insert(interactiveContents).values({
        id,
        organizationId: activity.organizationId,
        activityId: activity.id,
        kind,
        embedUrl,
        packageFileId: kind === "h5p" ? s.packageFileId! : null,
        gradeMax: s.gradeMax ?? 100,
        settings: h5p ? { h5p } : {},
      });
    },
    async update(tx, { activity, userId }, s) {
      const row = await interactiveOf(tx, activity.id);
      if (!row) throw badRequest("Interactive content is missing");
      const kind = s.kind ?? row.kind;
      const patch: Partial<typeof interactiveContents.$inferInsert> = { kind };
      if (s.gradeMax !== undefined) patch.gradeMax = s.gradeMax;
      const oldPrefix = h5pInfo(row)?.prefix;
      if (kind === "embed") {
        patch.embedUrl = s.embedUrl !== undefined ? resolveEmbed(s.embedUrl) : resolveEmbed(row.embedUrl);
        if (oldPrefix) {
          await queuePackageCleanup(tx, activity.organizationId, oldPrefix);
          // Forget the deleted package so switching back to H5P installs it again.
          patch.settings = Object.fromEntries(Object.entries(row.settings ?? {}).filter(([k]) => k !== "h5p"));
        }
      } else {
        const fileId = s.packageFileId !== undefined ? s.packageFileId : row.packageFileId;
        if (!fileId) throw badRequest("Upload an H5P package");
        if (fileId !== row.packageFileId || !h5pInfo(row)) {
          const h5p = await installPackage(tx, activity, userId, row.id, fileId);
          patch.packageFileId = fileId;
          patch.settings = { ...row.settings, h5p };
          if (oldPrefix && oldPrefix !== h5p.prefix) await queuePackageCleanup(tx, activity.organizationId, oldPrefix);
        }
      }
      await tx.update(interactiveContents).set(patch).where(eq(interactiveContents.id, row.id));
    },
    async load(tx, activity) {
      const row = await interactiveOf(tx, activity.id);
      if (!row) return null;
      const h5p = h5pInfo(row);
      return {
        kind: row.kind,
        embedUrl: row.kind === "embed" ? row.embedUrl : null,
        embedProvider: row.kind === "embed" && row.embedUrl ? (normalizeEmbedUrl(row.embedUrl)?.provider ?? null) : null,
        packageFileId: row.packageFileId,
        h5p: h5p ? { title: h5p.title, mainLibrary: h5p.mainLibrary } : null,
        gradeMax: row.gradeMax,
      };
    },
    async grading(tx, activity) {
      const row = await interactiveOf(tx, activity.id);
      return { gradeMax: row?.gradeMax ?? 100, gradePass: null };
    },
  });

  // The raw .h5p download is for editors only; learners use the player.
  registerFileAccess("interactive", async (tx, req, file) => !!file.contextId && (await hasCapability(tx, req, "activity:update", file.contextId)));
}
