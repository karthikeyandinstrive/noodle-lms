import { eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod, ZodTypeProvider } from "fastify-type-provider-zod";
import { files, systemDb } from "@lms/db";
import { z } from "zod";
import { requireUser } from "../../core/auth";
import { badRequest, forbidden, must } from "../../core/errors";
import { completeUpload, createUpload, downloadUrl, getAuthorizedFile, MAX_UPLOAD_BYTES, registerFileAccess, softDeleteFile } from "../../core/files";
import { LocalDriver, verifyLocal } from "../../core/storage";
import { ok, zId, zOk } from "../../core/schemas";

/**
 * Generic upload endpoints. Components that store files with an itemId set
 * register their own access rule (registerFileAccess). "draft" files (not yet
 * attached to anything) are only visible to their owner.
 */
export const COMPONENTS = ["user", "course", "activity", "assignment", "forum", "workshop", "content", "certificate", "badge", "interactive", "organization", "draft"] as const;

const zFile = z.object({ id: zId, filename: z.string(), mimeType: z.string(), size: z.number(), status: z.string() });

export const routes: FastifyPluginAsyncZod = async (app) => {
  // Public-ish images (avatars, course images, org logo, badge images) are viewable by any signed-in member.
  for (const c of ["user", "course", "organization", "badge"] as const) {
    registerFileAccess(c, async (_tx, req) => !!req.user);
  }

  app.post(
    "/files/uploads",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        tags: ["Files"],
        summary: "Start an upload: returns a short-lived URL to PUT the file to",
        body: z.object({
          component: z.enum(COMPONENTS).default("draft"),
          area: z.string().regex(/^[a-z_]{1,40}$/).default("draft"),
          filename: z.string().min(1).max(255),
          mimeType: z.string().min(3).max(200),
          size: z.number().int().positive().max(MAX_UPLOAD_BYTES),
        }),
        response: { 201: z.object({ file: zFile, uploadUrl: z.string(), method: z.literal("PUT"), headers: z.record(z.string()) }) },
      },
    },
    async (req, reply) => {
      requireUser(req);
      const out = await req.tenant((tx) => createUpload(tx, req, req.body));
      return reply.status(201).send(out);
    },
  );

  app.post(
    "/files/:id/complete",
    { schema: { tags: ["Files"], summary: "Finish an upload after the PUT succeeded", params: z.object({ id: zId }), response: { 200: zFile } } },
    (req) => {
      requireUser(req);
      return req.tenant((tx) => completeUpload(tx, req, req.params.id));
    },
  );

  app.get(
    "/files/:id",
    {
      schema: {
        tags: ["Files"],
        summary: "Redirect to a short-lived signed download URL (access checked per component)",
        params: z.object({ id: zId }),
        querystring: z.object({ inline: z.coerce.boolean().default(false) }),
      },
    },
    async (req, reply) => {
      const url = await req.tenant(async (tx) => {
        const file = await getAuthorizedFile(tx, req, req.params.id);
        return downloadUrl(tx, req, file, req.query.inline);
      });
      reply.header("Cache-Control", "private, no-store");
      return reply.redirect(url, 302);
    },
  );

  app.get(
    "/files/:id/meta",
    { schema: { tags: ["Files"], summary: "File metadata", params: z.object({ id: zId }), response: { 200: zFile } } },
    (req) => req.tenant((tx) => getAuthorizedFile(tx, req, req.params.id)),
  );

  app.delete(
    "/files/:id",
    { schema: { tags: ["Files"], summary: "Delete one of your draft uploads", params: z.object({ id: zId }), response: { 200: zOk } } },
    async (req) => {
      const me = requireUser(req);
      await req.tenant(async (tx) => {
        const file = must((await tx.select().from(files).where(eq(files.id, req.params.id)).limit(1))[0], "File");
        if (file.ownerId !== me.id || file.component !== "draft") throw forbidden();
        await softDeleteFile(tx, file.id);
      });
      return ok;
    },
  );

  // ─── Local driver endpoints (signed URLs; used when STORAGE_DRIVER=local) ─

  const local = new LocalDriver();

  app.register(async (instance) => {
    const scope = instance.withTypeProvider<ZodTypeProvider>();
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: MAX_UPLOAD_BYTES }, (_req, body, done) => done(null, body));

    scope.put(
      "/files/local",
      {
        config: { tenant: false },
        schema: {
          hide: true,
          querystring: z.object({ key: z.string(), exp: z.coerce.number(), sig: z.string(), type: z.string(), max: z.coerce.number() }),
        },
      },
      async (req) => {
        const q = req.query;
        if (!verifyLocal("put", q.key, q.exp, q.sig, `${q.type}:${q.max}`)) throw forbidden("Invalid or expired upload URL");
        const body = req.body as Buffer;
        if (!Buffer.isBuffer(body) || body.length > q.max) throw badRequest("File exceeds the declared size");
        await local.put(q.key, body);
        return ok;
      },
    );
  });

  app.get(
    "/files/local",
    {
      config: { tenant: false },
      schema: { hide: true, querystring: z.object({ key: z.string(), exp: z.coerce.number(), sig: z.string(), name: z.string(), inline: z.string().optional() }) },
    },
    async (req, reply) => {
      const q = req.query;
      if (!verifyLocal("get", q.key, q.exp, q.sig)) throw forbidden("Invalid or expired download URL");
      const db = await systemDb();
      const [file] = await db.select().from(files).where(eq(files.storageKey, q.key)).limit(1);
      const body = await local.get(q.key);
      const disposition = `${q.inline === "1" ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(q.name)}`;
      return reply
        .header("Content-Type", file?.mimeType ?? "application/octet-stream")
        .header("Content-Disposition", disposition)
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Security-Policy", "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox")
        .header("Cache-Control", "private, max-age=300")
        .send(body);
    },
  );
};
