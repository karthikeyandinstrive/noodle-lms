import { and, eq, isNull } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { files, type DB } from "@lms/db";
import { sha256 } from "./crypto";
import { badRequest, forbidden, must } from "./errors";
import { driverForFile, storageFor, type Provider } from "./storage";

export type FileRow = typeof files.$inferSelect;

/** Upload limits shared by every component; modules may narrow them further. */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
const ALLOWED_MIME = [
  /^image\/(png|jpeg|gif|webp|svg\+xml)$/,
  /^video\/(mp4|webm)$/,
  /^audio\/(mpeg|ogg|wav|webm)$/,
  /^application\/pdf$/,
  // Windows browsers report .zip as x-zip-compressed.
  /^application\/(x-)?zip(-compressed)?$/,
  /^application\/(x-)?h5p(\+zip)?$/,
  /^application\/vnd\.openxmlformats-officedocument\./,
  /^application\/(msword|vnd\.ms-excel|vnd\.ms-powerpoint)$/,
  /^application\/vnd\.oasis\.opendocument\./,
  /^text\/(plain|csv|markdown)$/,
];
const BLOCKED_EXTENSIONS = /\.(exe|bat|cmd|sh|ps1|msi|dll|com|scr|js|mjs|html?|php|jar)$/i;

/**
 * Access rules per component: decides who may download a file.
 * Modules register theirs in `setup()`, e.g. assignment submissions are visible
 * to the submitter and to graders.
 */
type AccessRule = (tx: DB, req: FastifyRequest, file: FileRow) => Promise<boolean>;
const accessRules = new Map<string, AccessRule>();

export function registerFileAccess(component: string, rule: AccessRule) {
  accessRules.set(component, rule);
}

function safeFilename(name: string) {
  return name.replace(/[/\\?%*:|"<>\u0000-\u001f]/g, "_").slice(0, 200) || "file";
}

export function assertAllowedType(filename: string, mimeType: string, accepted?: string[]) {
  if (BLOCKED_EXTENSIONS.test(filename)) throw badRequest("This file type is not allowed");
  if (!ALLOWED_MIME.some((re) => re.test(mimeType))) throw badRequest(`File type ${mimeType} is not allowed`);
  if (accepted?.length) {
    const ext = filename.split(".").pop()?.toLowerCase() ?? "";
    if (!accepted.some((a) => a.toLowerCase() === mimeType || a.toLowerCase().replace(/^\./, "") === ext)) {
      throw badRequest(`Accepted file types: ${accepted.join(", ")}`);
    }
  }
}

/**
 * Step 1 of an upload: records a pending file and returns a short-lived URL the
 * client uploads to directly (S3 presigned PUT, or the local driver's signed route).
 */
export async function createUpload(
  tx: DB,
  req: FastifyRequest,
  input: {
    component: string;
    area: string;
    itemId?: string | null;
    contextId?: string | null;
    filename: string;
    mimeType: string;
    size: number;
    maxBytes?: number;
    accepted?: string[];
  },
) {
  const max = Math.min(input.maxBytes ?? MAX_UPLOAD_BYTES, MAX_UPLOAD_BYTES);
  if (input.size <= 0 || input.size > max) throw badRequest(`File must be smaller than ${Math.round(max / 1024 / 1024)} MB`);
  assertAllowedType(input.filename, input.mimeType, input.accepted);

  const driver = await storageFor(tx, req.org.id);
  const id = crypto.randomUUID();
  const key = `${req.org.id}/${input.component}/${input.area}/${id}`;
  const [file] = await tx
    .insert(files)
    .values({
      id,
      organizationId: req.org.id,
      ownerId: req.user?.id ?? null,
      contextId: input.contextId ?? null,
      component: input.component,
      area: input.area,
      itemId: input.itemId ?? null,
      storageKey: key,
      storageProvider: driver.provider,
      filename: safeFilename(input.filename),
      mimeType: input.mimeType,
      size: input.size,
    })
    .returning();
  const uploadUrl = await driver.presignUpload(key, input.mimeType, input.size);
  return { file: file!, uploadUrl, method: "PUT" as const, headers: { "Content-Type": input.mimeType } };
}

/** Step 2: verifies the object landed in storage with the declared size and marks it ready. */
export async function completeUpload(tx: DB, req: FastifyRequest, fileId: string) {
  const file = must(
    (await tx.select().from(files).where(and(eq(files.id, fileId), isNull(files.deletedAt))).limit(1))[0],
    "File",
  );
  if (file.ownerId !== req.user?.id) throw forbidden();
  if (file.status === "ready") return file;
  const driver = await driverForFile(tx, req.org.id, file.storageProvider as Provider);
  const head = await driver.head(file.storageKey);
  if (!head) throw badRequest("Upload not found in storage");
  if (head.size > file.size) {
    await driver.delete(file.storageKey);
    throw badRequest("Uploaded file is larger than declared");
  }
  const [updated] = await tx.update(files).set({ status: "ready", size: head.size }).where(eq(files.id, file.id)).returning();
  return updated!;
}

/** Stores a server-generated file (e.g. certificate PDF). */
export async function storeBuffer(
  tx: DB,
  organizationId: string,
  input: { component: string; area: string; itemId?: string | null; contextId?: string | null; ownerId?: string | null; filename: string; mimeType: string; body: Buffer },
) {
  const driver = await storageFor(tx, organizationId);
  const id = crypto.randomUUID();
  const key = `${organizationId}/${input.component}/${input.area}/${id}`;
  await driver.put(key, input.body, input.mimeType);
  const [file] = await tx
    .insert(files)
    .values({
      id,
      organizationId,
      ownerId: input.ownerId ?? null,
      contextId: input.contextId ?? null,
      component: input.component,
      area: input.area,
      itemId: input.itemId ?? null,
      storageKey: key,
      storageProvider: driver.provider,
      filename: safeFilename(input.filename),
      mimeType: input.mimeType,
      size: input.body.length,
      sha256: sha256(input.body),
      status: "ready",
    })
    .returning();
  return file!;
}

export async function readFileBody(tx: DB, organizationId: string, file: FileRow) {
  const driver = await driverForFile(tx, organizationId, file.storageProvider as Provider);
  return driver.get(file.storageKey);
}

/** Loads a ready file and enforces its component's access rule. Owners can always read their own files. */
export async function getAuthorizedFile(tx: DB, req: FastifyRequest, fileId: string) {
  const file = must(
    (await tx.select().from(files).where(and(eq(files.id, fileId), isNull(files.deletedAt), eq(files.status, "ready"))).limit(1))[0],
    "File",
  );
  if (req.user && file.ownerId === req.user.id) return file;
  const rule = accessRules.get(file.component);
  if (!rule || !(await rule(tx, req, file))) throw forbidden();
  return file;
}

export async function downloadUrl(tx: DB, req: FastifyRequest, file: FileRow, inline = false) {
  const driver = await driverForFile(tx, req.org.id, file.storageProvider as Provider);
  return driver.presignDownload(file.storageKey, file.filename, 300, inline);
}

/** Checks that files referenced by a client belong to this user and are ready (prevents attaching others' files). */
export async function assertOwnFiles(tx: DB, req: FastifyRequest, fileIds: string[]) {
  for (const id of fileIds) {
    const [f] = await tx.select().from(files).where(eq(files.id, id)).limit(1);
    if (!f || f.ownerId !== req.user?.id || f.status !== "ready") throw badRequest(`Invalid file ${id}`);
  }
}

export async function softDeleteFile(tx: DB, fileId: string) {
  await tx.update(files).set({ deletedAt: new Date() }).where(eq(files.id, fileId));
}
