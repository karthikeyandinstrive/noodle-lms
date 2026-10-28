import { eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { files } from "@lms/db";
import { z } from "zod";
import { must, notFound } from "../../core/errors";
import { downloadUrl } from "../../core/files";
import { zId } from "../../core/schemas";
import { loadActivity } from "../activities/service";
import { isInlineMime, parseOptions, type FileOptions } from "./options";
import { resourceOf } from "./service";

export const routes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/:activityId/file",
    {
      schema: {
        tags: ["Content"],
        summary: "Redirect to a short-lived signed URL for a file resource (inline for PDF/images/video unless ?download=true)",
        params: z.object({ activityId: zId }),
        querystring: z.object({ download: z.coerce.boolean().default(false) }),
      },
    },
    async (req, reply) => {
      const url = await req.tenant(async (tx) => {
        const { activity } = await loadActivity(tx, req, req.params.activityId, { type: "file" });
        const resource = await resourceOf(tx, activity.id);
        if (!resource?.fileId) throw notFound("File");
        const file = must((await tx.select().from(files).where(eq(files.id, resource.fileId)).limit(1))[0], "File");
        if (file.deletedAt || file.status !== "ready") throw notFound("File");
        const opts = parseOptions<FileOptions>(resource.content, { display: "inline" });
        const inline = !req.query.download && opts.display === "inline" && isInlineMime(file.mimeType);
        return downloadUrl(tx, req, file, inline);
      });
      reply.header("Cache-Control", "private, no-store");
      return reply.redirect(url, 302);
    },
  );
};
