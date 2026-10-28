import { eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { contentResources, files, type DB } from "@lms/db";
import { z } from "zod";
import type { ActivityRow } from "../../core/activity-types";
import { registerActivityType } from "../../core/activity-types";
import { assertOwnFiles, registerFileAccess } from "../../core/files";
import { hasCapability } from "../../core/rbac";
import { cleanHtml } from "../../core/sanitize";
import { zId } from "../../core/schemas";
import { isInlineMime, normalizeExternalUrl, parseOptions, type FileOptions, type UrlOptions } from "./options";

/**
 * Simple content activities: "page" (HTML), "url" (external link), "file" (one uploaded file).
 * All three share the `content_resources` table.
 */

export async function resourceOf(tx: DB, activityId: string) {
  const [row] = await tx.select().from(contentResources).where(eq(contentResources.activityId, activityId)).limit(1);
  return row ?? null;
}

async function upsertResource(tx: DB, activity: ActivityRow, patch: Partial<typeof contentResources.$inferInsert>) {
  const existing = await resourceOf(tx, activity.id);
  if (existing) {
    await tx.update(contentResources).set(patch).where(eq(contentResources.id, existing.id));
  } else {
    await tx.insert(contentResources).values({ organizationId: activity.organizationId, activityId: activity.id, ...patch });
  }
}

const zExternalUrl = z
  .string()
  .trim()
  .max(2000)
  .refine((v) => normalizeExternalUrl(v) !== null, "Enter a valid http(s) URL")
  .transform((v) => normalizeExternalUrl(v)!);

/**
 * The generic activities API only passes `ctx.userId`, so ownership checks for
 * attached files use a minimal request-like object.
 */
function asReq(userId: string) {
  return { user: { id: userId } } as unknown as FastifyRequest;
}

/** Verifies the file belongs to the editor (or is already attached here) and re-tags it to the activity. */
async function attachFile(tx: DB, activity: ActivityRow, userId: string, fileId: string) {
  const [file] = await tx.select().from(files).where(eq(files.id, fileId)).limit(1);
  const alreadyAttached = file && file.component === "content" && file.itemId === activity.id;
  if (!alreadyAttached) await assertOwnFiles(tx, asReq(userId), [fileId]);
  await tx
    .update(files)
    .set({ component: "content", area: "resource", itemId: activity.id, contextId: activity.contextId })
    .where(eq(files.id, fileId));
}

export function setupContent() {
  registerActivityType({
    type: "page",
    label: "Page",
    settings: z.object({ content: z.string().max(500_000).default("") }),
    async create(tx, { activity }, s) {
      await upsertResource(tx, activity, { content: cleanHtml(s.content ?? "") });
    },
    async update(tx, { activity }, s) {
      if (s.content !== undefined) await upsertResource(tx, activity, { content: cleanHtml(s.content) });
    },
    async load(tx, activity) {
      const r = await resourceOf(tx, activity.id);
      return { content: r?.content ?? "" };
    },
  });

  registerActivityType({
    type: "url",
    label: "Link",
    settings: z.object({ externalUrl: zExternalUrl, openInNewTab: z.boolean().default(true) }),
    async create(tx, { activity }, s) {
      const opts: UrlOptions = { openInNewTab: s.openInNewTab ?? true };
      await upsertResource(tx, activity, { externalUrl: s.externalUrl, content: JSON.stringify(opts) });
    },
    async update(tx, { activity }, s) {
      const r = await resourceOf(tx, activity.id);
      const opts = parseOptions<UrlOptions>(r?.content, { openInNewTab: true });
      if (s.openInNewTab !== undefined) opts.openInNewTab = s.openInNewTab;
      await upsertResource(tx, activity, {
        ...(s.externalUrl !== undefined ? { externalUrl: s.externalUrl } : {}),
        content: JSON.stringify(opts),
      });
    },
    async load(tx, activity) {
      const r = await resourceOf(tx, activity.id);
      const opts = parseOptions<UrlOptions>(r?.content, { openInNewTab: true });
      return { externalUrl: r?.externalUrl ?? null, openInNewTab: opts.openInNewTab };
    },
  });

  registerActivityType({
    type: "file",
    label: "File",
    settings: z.object({ fileId: zId, display: z.enum(["download", "inline"]).default("inline") }),
    async create(tx, { activity, userId }, s) {
      await attachFile(tx, activity, userId, s.fileId);
      const opts: FileOptions = { display: s.display ?? "inline" };
      await upsertResource(tx, activity, { fileId: s.fileId, content: JSON.stringify(opts) });
    },
    async update(tx, { activity, userId }, s) {
      const r = await resourceOf(tx, activity.id);
      const opts = parseOptions<FileOptions>(r?.content, { display: "inline" });
      if (s.display !== undefined) opts.display = s.display;
      if (s.fileId !== undefined && s.fileId !== r?.fileId) {
        await attachFile(tx, activity, userId, s.fileId);
        // The previous file stays in storage (soft-delete happens via files cleanup), but is detached.
        if (r?.fileId) await tx.update(files).set({ deletedAt: new Date() }).where(eq(files.id, r.fileId));
      }
      await upsertResource(tx, activity, { ...(s.fileId !== undefined ? { fileId: s.fileId } : {}), content: JSON.stringify(opts) });
    },
    async load(tx, activity) {
      const r = await resourceOf(tx, activity.id);
      const opts = parseOptions<FileOptions>(r?.content, { display: "inline" });
      const [file] = r?.fileId ? await tx.select().from(files).where(eq(files.id, r.fileId)).limit(1) : [];
      return {
        fileId: file && !file.deletedAt ? file.id : null,
        display: opts.display,
        filename: file?.filename ?? null,
        mimeType: file?.mimeType ?? null,
        size: file?.size ?? null,
        inlineSupported: file ? isInlineMime(file.mimeType) : false,
      };
    },
  });

  // Files attached to content activities: anyone who can view the course context.
  registerFileAccess("content", async (tx, req, file) => !!file.contextId && (await hasCapability(tx, req, "course:view", file.contextId)));
}

