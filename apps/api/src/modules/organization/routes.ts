import { and, count, desc, eq, gte, lte } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { auditLogs, bootstrapOrganization, getSystemContext, organizations, storageConfigs, systemDb, users, type DB } from "@lms/db";
import { z } from "zod";
import { config } from "../../config";
import { audit } from "../../core/audit";
import { decryptSecret, encryptSecret, maskSecret } from "../../core/crypto";
import { badRequest, forbidden } from "../../core/errors";
import { cache } from "../../core/redis";
import { requireCapability } from "../../core/rbac";
import { assertSafeEndpoint, S3Driver } from "../../core/storage";
import { offset, ok, paged, zDate, zDateInput, zId, zOk, zPagination } from "../../core/schemas";
import { zPassword } from "../auth/service";

const zSettings = z.object({
  selfRegistration: z.boolean().optional(),
  defaultLocale: z.string().max(10).optional(),
  defaultTimezone: z.string().max(64).optional(),
  brandColor: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
  logoFileId: zId.nullable().optional(),
  supportEmail: z.string().email().nullable().optional(),
});

const zOrg = z.object({ id: zId, name: z.string(), slug: z.string(), customDomain: z.string().nullable(), plan: z.string(), settings: zSettings });

async function requireSiteCap(tx: DB, req: Parameters<typeof requireCapability>[1] & { org: { id: string } }, cap: "site:config" | "storage:manage" | "site:view_audit_log") {
  const system = await getSystemContext(tx, req.org.id);
  await requireCapability(tx, req, cap, system.id);
}

const zStorageInput = z.object({
  provider: z.enum(["s3", "minio", "r2"]),
  enabled: z.boolean(),
  endpoint: z.string().url().nullable().optional(),
  region: z.string().max(50).nullable().optional(),
  bucket: z.string().min(3).max(63),
  accessKeyId: z.string().min(1).max(200),
  /** Omit to keep the stored secret. */
  secretAccessKey: z.string().min(1).max(200).optional(),
  publicUrl: z.string().url().nullable().optional(),
});

const zStorage = z.object({
  provider: z.enum(["local", "s3", "minio", "r2"]),
  enabled: z.boolean(),
  endpoint: z.string().nullable(),
  region: z.string().nullable(),
  bucket: z.string(),
  accessKeyId: z.string(),
  secretAccessKey: z.string().describe("Masked"),
  publicUrl: z.string().nullable(),
});

function validateProvider(input: { provider: string; endpoint?: string | null; region?: string | null }) {
  if ((input.provider === "minio" || input.provider === "r2") && !input.endpoint) throw badRequest(`${input.provider} requires an endpoint`);
  if (input.provider === "s3" && !input.region) throw badRequest("AWS S3 requires a region");
}

export const routes: FastifyPluginAsyncZod = async (app) => {
  // ─── SaaS signup (no tenant yet) ────────────────────────────────────────

  app.post(
    "/organizations/signup",
    {
      config: { tenant: false, rateLimit: { max: 3, timeWindow: "1 hour" } },
      schema: {
        tags: ["Organization"],
        summary: "Create a new organization (SaaS mode)",
        body: z.object({
          name: z.string().trim().min(2).max(100),
          slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/, "Lowercase letters, numbers and dashes"),
          admin: z.object({ email: z.string().email(), password: zPassword, firstName: z.string().min(1).max(100), lastName: z.string().min(1).max(100) }),
        }),
        response: { 201: z.object({ organizationId: zId, url: z.string() }) },
      },
    },
    async (req, reply) => {
      if (!config.SAAS_MODE) throw forbidden("Organization signup is disabled");
      if (["www", "api", "app", "admin", "default"].includes(req.body.slug)) throw badRequest("This address is reserved");
      const db = await systemDb();
      const { organization } = await db.transaction((tx) => bootstrapOrganization(tx as unknown as DB, req.body));
      const url = new URL(config.APP_URL);
      url.hostname = `${organization.slug}.${config.BASE_DOMAIN}`;
      return reply.status(201).send({ organizationId: organization.id, url: url.toString() });
    },
  );

  // ─── Settings ───────────────────────────────────────────────────────────

  app.get("/organization", { schema: { tags: ["Organization"], summary: "Organization settings", response: { 200: zOrg } } }, (req) =>
    req.tenant(async (tx) => {
      await requireSiteCap(tx, req, "site:config");
      const [org] = await tx.select().from(organizations).where(eq(organizations.id, req.org.id));
      return { ...org!, settings: org!.settings as z.infer<typeof zSettings> };
    }),
  );

  app.patch(
    "/organization",
    {
      schema: {
        tags: ["Organization"],
        summary: "Update organization name, domain and settings",
        body: z.object({
          name: z.string().trim().min(2).max(100).optional(),
          customDomain: z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i).nullable().optional(),
          settings: zSettings.optional(),
        }),
        response: { 200: zOrg },
      },
    },
    async (req) => {
      const result = await req.tenant(async (tx) => {
        await requireSiteCap(tx, req, "site:config");
        const [current] = await tx.select().from(organizations).where(eq(organizations.id, req.org.id));
        const [org] = await tx
          .update(organizations)
          .set({
            ...(req.body.name ? { name: req.body.name } : {}),
            ...(req.body.customDomain !== undefined ? { customDomain: req.body.customDomain?.toLowerCase() ?? null } : {}),
            ...(req.body.settings ? { settings: { ...current!.settings, ...req.body.settings } } : {}),
          })
          .where(eq(organizations.id, req.org.id))
          .returning();
        await audit(tx, req, "organization.updated", { type: "organization", id: req.org.id }, { fields: Object.keys(req.body) });
        return { ...org!, settings: org!.settings as z.infer<typeof zSettings> };
      });
      // Host → org mapping is cached.
      await cache.del(`org:host:${req.hostname}`, ...(result.customDomain ? [`org:host:${result.customDomain}`] : []));
      return result;
    },
  );

  // ─── Storage configuration ──────────────────────────────────────────────

  app.get(
    "/storage/config",
    { schema: { tags: ["Storage"], summary: "Current storage configuration (secret masked)", response: { 200: zStorage.nullable() } } },
    (req) =>
      req.tenant(async (tx) => {
        await requireSiteCap(tx, req, "storage:manage");
        const [cfg] = await tx.select().from(storageConfigs).where(eq(storageConfigs.organizationId, req.org.id));
        if (!cfg) return null;
        return { ...cfg, secretAccessKey: maskSecret(decryptSecret(cfg.secretAccessKeyEnc)) };
      }),
  );

  app.post(
    "/storage/config",
    { schema: { tags: ["Storage"], summary: "Save storage credentials (secret is encrypted at rest)", body: zStorageInput, response: { 200: zOk } } },
    async (req) => {
      validateProvider(req.body);
      if (req.body.endpoint) await assertSafeEndpoint(req.body.endpoint);
      await req.tenant(async (tx) => {
        await requireSiteCap(tx, req, "storage:manage");
        const [existing] = await tx.select().from(storageConfigs).where(eq(storageConfigs.organizationId, req.org.id));
        const { secretAccessKey, ...rest } = req.body;
        if (!existing && !secretAccessKey) throw badRequest("secretAccessKey is required");
        const values = { ...rest, secretAccessKeyEnc: secretAccessKey ? encryptSecret(secretAccessKey) : existing!.secretAccessKeyEnc };
        if (existing) await tx.update(storageConfigs).set(values).where(eq(storageConfigs.id, existing.id));
        else await tx.insert(storageConfigs).values({ ...values, organizationId: req.org.id });
        await audit(tx, req, "storage.config_updated", { type: "organization", id: req.org.id }, { provider: rest.provider, bucket: rest.bucket, enabled: rest.enabled });
      });
      return ok;
    },
  );

  app.post(
    "/storage/test",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["Storage"],
        summary: "Test a storage connection (uses the saved secret if none is given)",
        body: zStorageInput.omit({ enabled: true }),
        response: { 200: z.object({ ok: z.boolean(), message: z.string() }) },
      },
    },
    async (req) => {
      validateProvider(req.body);
      if (req.body.endpoint) await assertSafeEndpoint(req.body.endpoint);
      const secret = await req.tenant(async (tx) => {
        await requireSiteCap(tx, req, "storage:manage");
        if (req.body.secretAccessKey) return req.body.secretAccessKey;
        const [cfg] = await tx.select().from(storageConfigs).where(eq(storageConfigs.organizationId, req.org.id));
        if (!cfg) throw badRequest("secretAccessKey is required");
        return decryptSecret(cfg.secretAccessKeyEnc);
      });
      try {
        await new S3Driver({ ...req.body, secretAccessKey: secret }).test();
        return { ok: true, message: "Connected to bucket" };
      } catch (err) {
        // Return only a generic class of error: raw SDK messages can echo internal details.
        const name = (err as { name?: string }).name ?? "Error";
        return { ok: false, message: `Connection failed (${name})` };
      }
    },
  );

  // ─── Audit log ──────────────────────────────────────────────────────────

  app.get(
    "/audit-logs",
    {
      schema: {
        tags: ["Organization"],
        summary: "Administrative audit trail",
        querystring: zPagination.extend({ action: z.string().max(100).optional(), actorId: zId.optional(), from: zDateInput.optional(), to: zDateInput.optional() }),
        response: {
          200: paged(
            z.object({
              id: zId,
              action: z.string(),
              targetType: z.string().nullable(),
              targetId: z.string().nullable(),
              metadata: z.record(z.unknown()),
              ip: z.string().nullable(),
              createdAt: zDate,
              actor: z.object({ id: zId, firstName: z.string(), lastName: z.string() }).nullable(),
            }),
          ),
        },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        await requireSiteCap(tx, req, "site:view_audit_log");
        const q = req.query;
        const where = and(
          q.action ? eq(auditLogs.action, q.action) : undefined,
          q.actorId ? eq(auditLogs.actorId, q.actorId) : undefined,
          q.from ? gte(auditLogs.createdAt, q.from) : undefined,
          q.to ? lte(auditLogs.createdAt, q.to) : undefined,
        );
        const rows = await tx
          .select({ log: auditLogs, actor: { id: users.id, firstName: users.firstName, lastName: users.lastName } })
          .from(auditLogs)
          .leftJoin(users, eq(users.id, auditLogs.actorId))
          .where(where)
          .orderBy(desc(auditLogs.createdAt))
          .limit(q.pageSize)
          .offset(offset(q));
        const [{ total }] = (await tx.select({ total: count() }).from(auditLogs).where(where)) as [{ total: number }];
        return {
          items: rows.map((r) => ({ ...r.log, actor: r.actor?.id ? r.actor : null })),
          total,
          page: q.page,
          pageSize: q.pageSize,
        };
      }),
  );
};
