import { and, asc, eq, gt, inArray, isNull, lt } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import {
  activities,
  auditLogs,
  courses,
  enrolments,
  getSystemContext,
  ltiKeys,
  ltiLaunches,
  ltiLinks,
  ltiTools,
  organizations,
  roleAssignments,
  roles,
  sessions,
  systemDb,
  users,
  withTenant,
  type DB,
} from "@lms/db";
import { z } from "zod";
import { config } from "../../config";
import { audit } from "../../core/audit";
import { requireUser, SESSION_COOKIE } from "../../core/auth";
import { randomToken, sha256 } from "../../core/crypto";
import { AppError, badRequest, conflict, must, notFound, unauthorized } from "../../core/errors";
import { emitInTx } from "../../core/events";
import { hasCapability, requireCapability } from "../../core/rbac";
import { cache } from "../../core/redis";
import { ok, zDate, zId, zOk, patchSchema } from "../../core/schemas";
import type { SessionUser } from "../../core/types";
import { loadActivity } from "../activities/service";
import { isEnrolled } from "../courses/service";
import { pushGrade, syncActivityGradeItem } from "../gradebook/service";
import {
  ACTIVITY_PROGRESS,
  AGS_SCOPES,
  autoSubmitPage,
  buildLaunchClaims,
  checkAuthRequest,
  errorPage,
  escapeHtml,
  formPageCsp,
  GRADING_PROGRESS,
  isSubmission,
  LTI,
  MEDIA,
  parseDeepLinkingResponse,
  parseForm,
  rolesFor,
  rolesForArchetypes,
  SCOPES,
  scoreToGrade,
  substituteCustom,
  SUPPORTED_SCOPES,
  type AuthRequest,
} from "./claims";
import { jwks, rotateKey, signJwt } from "./keys";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  assertRedirectUri,
  assertToolUrl,
  bearerOf,
  issueAccessToken,
  linkOf,
  newClientId,
  newDeploymentId,
  normalizeScopes,
  OAuthError,
  orgInfo,
  toolById,
  verifyAccessToken,
  verifyClientAssertion,
  verifyToolMessage,
  type AccessToken,
} from "./service";

const LAUNCH_TTL_MS = 5 * 60 * 1000;
/** How long a teacher may take to pick content in the tool after the Deep Linking launch. */
const DEEP_LINK_TTL_MS = 60 * 60 * 1000;
const allowHttp = !config.isProd;

const zTool = z.object({
  id: zId,
  name: z.string(),
  description: z.string().nullable(),
  clientId: z.string(),
  deploymentId: z.string(),
  loginUrl: z.string(),
  launchUrl: z.string(),
  deepLinkingUrl: z.string().nullable(),
  jwksUrl: z.string(),
  redirectUris: z.array(z.string()),
  scopes: z.array(z.string()),
  sharePersonalData: z.boolean(),
  enabled: z.boolean(),
  createdAt: zDate,
});

const zUrl = z.string().trim().url().max(2000);
const zToolInput = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().trim().max(2000).nullable().optional(),
  loginUrl: zUrl,
  launchUrl: zUrl,
  /** Deep Linking (content selection) endpoint, when it differs from the launch URL. */
  deepLinkingUrl: zUrl.nullable().optional(),
  jwksUrl: zUrl,
  redirectUris: z.array(zUrl).max(20).default([]),
  scopes: z.array(z.string().max(200)).max(10).default(SUPPORTED_SCOPES),
  sharePersonalData: z.boolean().default(true),
  enabled: z.boolean().default(true),
});

const zToolConfig = z.object({
  issuer: z.string(),
  clientId: z.string(),
  deploymentId: z.string(),
  authLoginUrl: z.string(),
  accessTokenUrl: z.string(),
  jwksUrl: z.string(),
  redirectUris: z.array(z.string()),
  scopes: z.array(z.string()),
});

const zAuthParams = z
  .object({
    scope: z.string().max(500),
    response_type: z.string().max(50),
    response_mode: z.string().max(50),
    prompt: z.string().max(50),
    client_id: z.string().max(200),
    redirect_uri: z.string().max(2000),
    login_hint: z.string().max(200),
    lti_message_hint: z.string().max(200),
    state: z.string().max(4000),
    nonce: z.string().max(500),
  })
  .partial();

const zOAuthError = z.object({ error: z.string(), error_description: z.string().optional() });

async function systemContextId(tx: DB, req: FastifyRequest) {
  return (await getSystemContext(tx, req.org.id)).id;
}

async function requireToolAdmin(tx: DB, req: FastifyRequest) {
  requireUser(req);
  await requireCapability(tx, req, "lti:manage_tools", await systemContextId(tx, req));
}

async function validateToolUrls(t: { loginUrl?: string; launchUrl?: string; deepLinkingUrl?: string | null; jwksUrl?: string; redirectUris?: string[] }) {
  if (t.loginUrl) await assertToolUrl(t.loginUrl, "Login URL");
  if (t.launchUrl) await assertToolUrl(t.launchUrl, "Launch URL");
  if (t.deepLinkingUrl) await assertToolUrl(t.deepLinkingUrl, "Deep Linking URL");
  if (t.jwksUrl) await assertToolUrl(t.jwksUrl, "JWKS URL");
  for (const u of t.redirectUris ?? []) assertRedirectUri(u);
}

function sendHtml(reply: FastifyReply, status: number, html: string, csp: string) {
  return reply
    .status(status)
    .header("Content-Security-Policy", csp)
    .header("Cache-Control", "no-store")
    .header("Referrer-Policy", "origin")
    .header("X-Content-Type-Options", "nosniff")
    .type("text/html; charset=utf-8")
    .send(html);
}

const errorCsp = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'";

/** A user object usable with hasCapability() outside a tenant request (tenant: false routes). */
const asCapReq = (user: SessionUser) => ({ user, capabilityCache: new Map<string, boolean>() });

/** OAuth2 bearer check for the LTI services. */
function serviceToken(req: FastifyRequest, anyOf: string[]): AccessToken {
  const token = verifyAccessToken(bearerOf(req.headers.authorization));
  if (!token) throw unauthorized("A valid LTI access token is required");
  if (!token.s.some((s) => anyOf.includes(s))) throw new AppError(403, "INSUFFICIENT_SCOPE", "The access token does not grant this service");
  return token;
}

/** Loads the activity's LTI link for a service call, verifying that the token's tool owns it. */
async function serviceLink(tx: DB, token: AccessToken, activityId: string) {
  const row = await linkOf(tx, activityId);
  if (!row || row.tool.id !== token.t || !row.tool.enabled) throw notFound("Line item");
  const activity = must((await tx.select().from(activities).where(eq(activities.id, activityId)).limit(1))[0], "Activity");
  const course = must((await tx.select().from(courses).where(eq(courses.id, activity.courseId)).limit(1))[0], "Course");
  return { ...row, activity, course };
}

export const routes: FastifyPluginAsyncZod = async (app) => {
  // OAuth/OIDC endpoints receive form posts; AGS scores use their own JSON media type.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 64 * 1024 }, (_req, body, done) =>
    done(null, parseForm(body as string)),
  );
  app.addContentTypeParser([MEDIA.score, MEDIA.lineItem], { parseAs: "string", bodyLimit: 64 * 1024 }, (_req, body, done) => {
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(badRequest("Invalid JSON body"), undefined);
    }
  });

  // ─── Platform keys ──────────────────────────────────────────────────────

  app.get(
    "/jwks/:organizationId",
    {
      config: { tenant: false, rateLimit: { max: 120, timeWindow: "1 minute" } },
      schema: {
        tags: ["LTI"],
        summary: "Public JSON Web Key Set of the organization's LTI platform keys",
        params: z.object({ organizationId: zId }),
        response: { 200: z.object({ keys: z.array(z.record(z.string(), z.unknown())) }) },
      },
    },
    async (req, reply) => {
      const out = await withTenant(req.params.organizationId, async (tx) => {
        const [org] = await tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, req.params.organizationId)).limit(1);
        if (!org) throw notFound("Organization");
        return jwks(tx, org.id);
      });
      return reply.header("Cache-Control", "public, max-age=300").header("Access-Control-Allow-Origin", "*").send(out);
    },
  );

  app.get(
    "/keys",
    {
      schema: {
        tags: ["LTI"],
        summary: "Platform signing keys (public part only)",
        response: { 200: z.array(z.object({ kid: z.string(), active: z.boolean(), createdAt: zDate })) },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        await requireToolAdmin(tx, req);
        const published = new Set((await jwks(tx, req.org.id)).keys.map((k) => k.kid));
        const rows = await tx.select().from(ltiKeys).orderBy(asc(ltiKeys.createdAt));
        return rows.filter((r) => published.has(r.kid)).map((r) => ({ kid: r.kid, active: r.active, createdAt: r.createdAt })).reverse();
      }),
  );

  app.post(
    "/keys/rotate",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 hour" } },
      schema: {
        tags: ["LTI"],
        summary: "Rotate the platform signing key (previous keys stay published for 7 days)",
        response: { 200: z.object({ kid: z.string() }) },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        await requireToolAdmin(tx, req);
        const key = await rotateKey(tx, req.org.id);
        await audit(tx, req, "lti.key_rotated", { type: "lti_key", id: key.id }, { kid: key.kid });
        return { kid: key.kid };
      }),
  );

  // ─── Tool registry ──────────────────────────────────────────────────────

  app.get(
    "/tools",
    { schema: { tags: ["LTI"], summary: "Registered external tools (lti:manage_tools)", response: { 200: z.array(zTool) } } },
    (req) =>
      req.tenant(async (tx) => {
        await requireToolAdmin(tx, req);
        return tx.select().from(ltiTools).orderBy(asc(ltiTools.name));
      }),
  );

  app.get(
    "/tools/available",
    {
      schema: {
        tags: ["LTI"],
        summary: "Enabled tools that teachers can add to a course",
        response: { 200: z.array(z.object({ id: zId, name: z.string(), description: z.string().nullable() })) },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        requireUser(req);
        return tx
          .select({ id: ltiTools.id, name: ltiTools.name, description: ltiTools.description })
          .from(ltiTools)
          .where(eq(ltiTools.enabled, true))
          .orderBy(asc(ltiTools.name));
      }),
  );

  app.post(
    "/tools",
    {
      schema: { tags: ["LTI"], summary: "Register an LTI 1.3 tool", body: zToolInput, response: { 201: zTool } },
    },
    async (req, reply) => {
      const out = await req.tenant(async (tx) => {
        await requireToolAdmin(tx, req);
        const b = req.body;
        const redirectUris = b.redirectUris.length ? b.redirectUris : [b.launchUrl];
        await validateToolUrls({ ...b, redirectUris });
        const [tool] = await tx
          .insert(ltiTools)
          .values({
            organizationId: req.org.id,
            name: b.name,
            description: b.description ?? null,
            clientId: newClientId(),
            deploymentId: newDeploymentId(),
            loginUrl: b.loginUrl,
            launchUrl: b.launchUrl,
            deepLinkingUrl: b.deepLinkingUrl ?? null,
            jwksUrl: b.jwksUrl,
            redirectUris: [...new Set(redirectUris)],
            scopes: normalizeScopes(b.scopes),
            sharePersonalData: b.sharePersonalData,
            enabled: b.enabled,
          })
          .returning();
        await audit(tx, req, "lti.tool_created", { type: "lti_tool", id: tool!.id }, { name: tool!.name, loginUrl: tool!.loginUrl });
        return tool!;
      });
      return reply.status(201).send(out);
    },
  );

  app.patch(
    "/tools/:id",
    {
      schema: { tags: ["LTI"], summary: "Update an LTI tool", params: z.object({ id: zId }), body: patchSchema(zToolInput), response: { 200: zTool } },
    },
    (req) =>
      req.tenant(async (tx) => {
        await requireToolAdmin(tx, req);
        const tool = must(await toolById(tx, req.params.id), "Tool");
        const b = req.body;
        await validateToolUrls(b);
        const patch: Partial<typeof ltiTools.$inferInsert> = { updatedAt: new Date() };
        if (b.name !== undefined) patch.name = b.name;
        if (b.description !== undefined) patch.description = b.description;
        if (b.loginUrl !== undefined) patch.loginUrl = b.loginUrl;
        if (b.launchUrl !== undefined) patch.launchUrl = b.launchUrl;
        if (b.deepLinkingUrl !== undefined) patch.deepLinkingUrl = b.deepLinkingUrl;
        if (b.jwksUrl !== undefined) patch.jwksUrl = b.jwksUrl;
        if (b.redirectUris !== undefined) patch.redirectUris = b.redirectUris.length ? [...new Set(b.redirectUris)] : [b.launchUrl ?? tool.launchUrl];
        if (b.scopes !== undefined) patch.scopes = normalizeScopes(b.scopes);
        if (b.sharePersonalData !== undefined) patch.sharePersonalData = b.sharePersonalData;
        if (b.enabled !== undefined) patch.enabled = b.enabled;
        const [updated] = await tx.update(ltiTools).set(patch).where(eq(ltiTools.id, tool.id)).returning();
        await audit(tx, req, "lti.tool_updated", { type: "lti_tool", id: tool.id }, { fields: Object.keys(b) });
        return updated!;
      }),
  );

  app.delete(
    "/tools/:id",
    { schema: { tags: ["LTI"], summary: "Delete an unused LTI tool", params: z.object({ id: zId }), response: { 200: zOk } } },
    (req) =>
      req.tenant(async (tx) => {
        await requireToolAdmin(tx, req);
        const tool = must(await toolById(tx, req.params.id), "Tool");
        const used = await tx.select({ id: ltiLinks.id }).from(ltiLinks).where(eq(ltiLinks.toolId, tool.id)).limit(1);
        if (used.length) throw conflict("This tool is used by activities. Disable it instead.");
        await tx.delete(ltiTools).where(eq(ltiTools.id, tool.id));
        await audit(tx, req, "lti.tool_deleted", { type: "lti_tool", id: tool.id }, { name: tool.name });
        return ok;
      }),
  );

  app.get(
    "/tools/:id/config",
    {
      schema: {
        tags: ["LTI"],
        summary: "Platform details to enter in the tool's configuration",
        params: z.object({ id: zId }),
        response: { 200: zToolConfig },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        await requireToolAdmin(tx, req);
        const tool = must(await toolById(tx, req.params.id), "Tool");
        const { urls } = await orgInfo(tx, req.org.id);
        return {
          issuer: urls.issuer,
          clientId: tool.clientId,
          deploymentId: tool.deploymentId,
          authLoginUrl: urls.authUrl,
          accessTokenUrl: urls.tokenUrl,
          jwksUrl: urls.jwksUrl,
          redirectUris: tool.redirectUris,
          scopes: tool.scopes,
        };
      }),
  );

  // ─── Launch: OIDC third-party initiated login ───────────────────────────

  app.get(
    "/:activityId/launch",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        tags: ["LTI"],
        summary: "Starts an LTI 1.3 launch (HTML page that auto-submits to the tool's OIDC login URL)",
        params: z.object({ activityId: zId }),
      },
    },
    async (req, reply) => {
      const me = requireUser(req);
      const out = await req.tenant(async (tx) => {
        const { activity } = await loadActivity(tx, req, req.params.activityId, { type: "lti", capability: "lti:launch" });
        const row = await linkOf(tx, activity.id);
        if (!row) throw notFound("External tool");
        if (!row.tool.enabled) throw badRequest("This external tool is disabled");
        const hint = randomToken(32);
        await tx.insert(ltiLaunches).values({
          organizationId: req.org.id,
          activityId: activity.id,
          userId: me.id,
          hint,
          expiresAt: new Date(Date.now() + LAUNCH_TTL_MS),
        });
        // Opportunistic cleanup of this user's stale launch rows.
        await tx.delete(ltiLaunches).where(and(eq(ltiLaunches.userId, me.id), lt(ltiLaunches.expiresAt, new Date(Date.now() - 60 * 60 * 1000))));
        const { urls } = await orgInfo(tx, req.org.id);
        return {
          action: row.tool.loginUrl,
          fields: {
            iss: urls.issuer,
            login_hint: me.id,
            target_link_uri: row.link.targetLinkUri ?? row.tool.launchUrl,
            lti_message_hint: hint,
            client_id: row.tool.clientId,
            lti_deployment_id: row.tool.deploymentId,
          },
        };
      });
      const nonce = randomToken(16);
      return sendHtml(
        reply,
        200,
        autoSubmitPage({ action: out.action, method: "POST", fields: out.fields, title: "Launching external tool", button: "Continue", nonce }),
        formPageCsp(nonce, allowHttp),
      );
    },
  );

  // ─── Deep Linking: the teacher picks content in the tool ────────────────

  app.get(
    "/:activityId/deep-link",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags: ["LTI"],
        summary: "Starts an LTI Deep Linking request (choose content in the tool for this activity)",
        params: z.object({ activityId: zId }),
      },
    },
    async (req, reply) => {
      const me = requireUser(req);
      const out = await req.tenant(async (tx) => {
        const { activity } = await loadActivity(tx, req, req.params.activityId, { type: "lti", capability: "activity:update" });
        const row = await linkOf(tx, activity.id);
        if (!row) throw notFound("External tool");
        if (!row.tool.enabled) throw badRequest("This external tool is disabled");
        const hint = randomToken(32);
        await tx.insert(ltiLaunches).values({
          organizationId: req.org.id,
          activityId: activity.id,
          userId: me.id,
          hint,
          messageType: "LtiDeepLinkingRequest",
          expiresAt: new Date(Date.now() + LAUNCH_TTL_MS),
        });
        const { urls } = await orgInfo(tx, req.org.id);
        return {
          action: row.tool.loginUrl,
          fields: {
            iss: urls.issuer,
            login_hint: me.id,
            target_link_uri: row.tool.deepLinkingUrl ?? row.tool.launchUrl,
            lti_message_hint: hint,
            client_id: row.tool.clientId,
            lti_deployment_id: row.tool.deploymentId,
          },
        };
      });
      const nonce = randomToken(16);
      return sendHtml(
        reply,
        200,
        autoSubmitPage({ action: out.action, method: "POST", fields: out.fields, title: "Opening the tool to choose content", button: "Continue", nonce }),
        formPageCsp(nonce, allowHttp),
      );
    },
  );

  /**
   * The tool posts the teacher's selection back here (cross-site form post: no session cookie).
   * Trust comes from the tool's signature plus the echoed `data`, which is the single-use launch
   * hint of a Deep Linking request that this teacher started and whose authentication completed.
   */
  app.post(
    "/deep-link/return",
    {
      config: { tenant: false, rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: { tags: ["LTI"], summary: "Deep Linking response (form post from the tool)", body: z.object({ JWT: z.string().max(64_000) }).partial().passthrough() },
    },
    async (req, reply) => {
      const fail = (message: string, status = 400) => sendHtml(reply, status, errorPage(message), errorCsp);
      const jwt = req.body?.JWT;
      if (!jwt) return fail("The tool did not send a response");
      let verified: Awaited<ReturnType<typeof verifyToolMessage>>;
      try {
        verified = await verifyToolMessage(jwt);
      } catch (err) {
        return fail(err instanceof Error ? err.message : "The tool's response could not be verified");
      }
      const { tool, payload } = verified;
      const data = typeof payload[LTI.dlData] === "string" ? (payload[LTI.dlData] as string) : "";
      if (!data) return fail("The response does not belong to a content selection request");

      let result: { activityId: string; base: string; message: string | null; picked: boolean } | { error: string };
      try {
        result = await withTenant(tool.organizationId, async (tx) => {
          const [launch] = await tx.select().from(ltiLaunches).where(eq(ltiLaunches.hint, data)).limit(1);
          if (!launch || launch.messageType !== "LtiDeepLinkingRequest" || !launch.usedAt) return { error: "The response does not belong to a content selection request" };
          if (launch.completedAt) return { error: "This selection was already saved" };
          if (launch.usedAt.getTime() < Date.now() - DEEP_LINK_TTL_MS) return { error: "The selection took too long. Start again from the activity settings." };
          const row = await linkOf(tx, launch.activityId);
          if (!row || row.tool.id !== tool.id) return { error: "The response came from a different tool" };

          let parsed: ReturnType<typeof parseDeepLinkingResponse>;
          try {
            parsed = parseDeepLinkingResponse(payload as Record<string, unknown>, { deploymentId: tool.deploymentId, data });
          } catch (err) {
            return { error: err instanceof Error ? err.message : "Invalid response" };
          }
          const [claimed] = await tx
            .update(ltiLaunches)
            .set({ completedAt: new Date() })
            .where(and(eq(ltiLaunches.id, launch.id), isNull(ltiLaunches.completedAt)))
            .returning();
          if (!claimed) return { error: "This selection was already saved" };

          const { base } = await orgInfo(tx, tool.organizationId);
          const pick = parsed.selection;
          if (!pick) return { activityId: launch.activityId, base, message: parsed.message, picked: false };
          if (pick.url) await assertToolUrl(pick.url, "Content URL");
          await tx
            .update(ltiLinks)
            .set({
              targetLinkUri: pick.url ?? row.link.targetLinkUri,
              customParams: Object.keys(pick.custom).length ? pick.custom : row.link.customParams,
              gradeMax: pick.scoreMaximum ?? row.link.gradeMax,
              openInNewWindow: pick.openInNewWindow,
            })
            .where(eq(ltiLinks.id, row.link.id));
          let [activity] = await tx.select().from(activities).where(eq(activities.id, launch.activityId)).limit(1);
          if (pick.title) [activity] = await tx.update(activities).set({ name: pick.title }).where(eq(activities.id, launch.activityId)).returning();
          if (pick.scoreMaximum !== null) await syncActivityGradeItem(tx, activity!, { gradeMax: pick.scoreMaximum, gradePass: null });
          await tx.insert(auditLogs).values({
            organizationId: tool.organizationId,
            actorId: launch.userId,
            action: "lti.deep_link_saved",
            targetType: "activity",
            targetId: launch.activityId,
            metadata: { toolId: tool.id, url: pick.url, title: pick.title },
            ip: req.ip,
            userAgent: req.headers["user-agent"]?.slice(0, 500),
          });
          return { activityId: launch.activityId, base, message: parsed.message, picked: true };
        });
      } catch (err) {
        req.log.error({ err }, "lti deep link return failed");
        return fail(err instanceof AppError ? err.message : "The selection could not be saved", err instanceof AppError ? 400 : 500);
      }
      if ("error" in result) return fail(result.error);
      const nonce = randomToken(16);
      const status = result.picked ? "selected" : "cancelled";
      return sendHtml(
        reply,
        200,
        autoSubmitPage({
          action: `${result.base}/activities/${result.activityId}/edit`,
          method: "GET",
          fields: { deepLink: status },
          title: result.picked ? (result.message ?? "Content selected") : (result.message ?? "Nothing was selected"),
          button: "Back to the activity",
          nonce,
        }),
        formPageCsp(nonce, allowHttp),
      );
    },
  );

  // ─── OIDC authorization endpoint (tool → platform) ──────────────────────

  /**
   * Session decision: the tool redirects the user's browser here (top-level navigation or
   * inside our iframe). Our session cookie is SameSite=Lax, so it arrives on a cross-site
   * GET navigation but NOT on a cross-site POST (nor, in most browsers, inside a frame whose
   * navigation was initiated cross-site). Therefore:
   *  - if a session cookie is present it MUST belong to the user the launch was issued for;
   *  - if it is absent, we rely on the launch row: an unguessable 256-bit, single-use hint,
   *    bound to `login_hint` (the user id) and valid for 5 minutes, that was created by an
   *    authenticated, capability-checked request of that same user.
   * The hint only ever travels user → tool → user, so a third party cannot obtain it.
   */
  const authorize = async (req: FastifyRequest, reply: FastifyReply, p: AuthRequest) => {
    const fail = (message: string, status = 400) => sendHtml(reply, status, errorPage(message), errorCsp);
    if (!p.lti_message_hint) return fail("lti_message_hint is required");

    const db = await systemDb();
    // Cross-tenant lookup by an unguessable value (like a session lookup); everything else runs in the tenant.
    const [launch] = await db.select().from(ltiLaunches).where(eq(ltiLaunches.hint, p.lti_message_hint)).limit(1);
    if (!launch || launch.usedAt || launch.expiresAt < new Date()) return fail("This launch has expired. Go back and launch the tool again.");

    const cookieToken = req.cookies[SESSION_COOKIE];
    let result: { redirectUri: string; idToken: string; state?: string } | { error: string };
    try {
      result = await withTenant(launch.organizationId, async (tx) => {
        const row = await linkOf(tx, launch.activityId);
        if (!row || !row.tool.enabled) return { error: "The external tool is not available" };
        const problem = checkAuthRequest(p, row.tool);
        if (problem) return { error: problem };
        if (p.login_hint !== launch.userId) return { error: "login_hint does not match the launch" };

        if (cookieToken) {
          const [s] = await tx
            .select({ userId: sessions.userId })
            .from(sessions)
            .where(and(eq(sessions.id, sha256(cookieToken)), gt(sessions.expiresAt, new Date())))
            .limit(1);
          if (s && s.userId !== launch.userId) return { error: "You are signed in as a different user than the one who launched the tool" };
        }

        const [consumed] = await tx
          .update(ltiLaunches)
          .set({ usedAt: new Date(), nonce: p.nonce!.slice(0, 500) })
          .where(and(eq(ltiLaunches.id, launch.id), isNull(ltiLaunches.usedAt), gt(ltiLaunches.expiresAt, new Date())))
          .returning();
        if (!consumed) return { error: "This launch has already been used" };

        const [user] = await tx.select().from(users).where(and(eq(users.id, launch.userId), eq(users.status, "active"), isNull(users.deletedAt))).limit(1);
        if (!user) return { error: "User not found" };
        const activity = must((await tx.select().from(activities).where(eq(activities.id, launch.activityId)).limit(1))[0], "Activity");
        const course = must((await tx.select().from(courses).where(eq(courses.id, activity.courseId)).limit(1))[0], "Course");
        const org = await orgInfo(tx, launch.organizationId);

        const capReq = asCapReq({ id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName, locale: user.locale, timezone: user.timezone });
        const sysCtx = await getSystemContext(tx, launch.organizationId);
        const canEdit = await hasCapability(tx, capReq, "activity:update", activity.contextId);
        const deepLinking = launch.messageType === "LtiDeepLinkingRequest";
        if (deepLinking && !canEdit) return { error: "You can no longer edit this activity" };
        const roleUris = rolesFor({
          canEdit,
          canGrade: await hasCapability(tx, capReq, "activity:grade", activity.contextId),
          isSiteAdmin: await hasCapability(tx, capReq, "site:config", sysCtx.id),
        });
        const agsScopes = row.tool.scopes.filter((s) => AGS_SCOPES.includes(s));
        const graded = row.link.gradeMax !== null;
        const claims = buildLaunchClaims({
          issuer: org.urls.issuer,
          clientId: row.tool.clientId,
          deploymentId: row.tool.deploymentId,
          nonce: p.nonce!,
          user,
          sharePersonalData: row.tool.sharePersonalData,
          roles: roleUris,
          activity: { id: activity.id, name: activity.name, description: activity.description },
          course,
          targetLinkUri: deepLinking ? (row.tool.deepLinkingUrl ?? row.tool.launchUrl) : (row.link.targetLinkUri ?? row.tool.launchUrl),
          documentTarget: row.link.openInNewWindow ? "window" : "iframe",
          returnUrl: org.urls.returnUrl(activity.id),
          custom: substituteCustom(row.link.customParams, {
            "$User.id": user.id,
            "$User.username": row.tool.sharePersonalData ? user.email : undefined,
            "$Person.email.primary": row.tool.sharePersonalData ? user.email : undefined,
            "$Context.id": course.id,
            "$CourseSection.sourcedId": course.id,
            "$ResourceLink.id": activity.id,
            "$ResourceLink.title": activity.name,
          }),
          platform: { guid: org.id, name: org.name },
          ags: !deepLinking && graded && agsScopes.length ? { scopes: agsScopes, lineItemUrl: org.urls.lineItemUrl(activity.id), lineItemsUrl: org.urls.lineItemsUrl(activity.id) } : null,
          nrps: !deepLinking && row.tool.scopes.includes(SCOPES.memberships) ? { membershipsUrl: org.urls.membershipsUrl(activity.id) } : null,
          deepLinking: deepLinking ? { returnUrl: org.urls.deepLinkReturnUrl, data: launch.hint } : null,
        });
        return { redirectUri: p.redirect_uri!, idToken: await signJwt(tx, launch.organizationId, claims), state: p.state };
      });
    } catch (err) {
      req.log.error({ err }, "lti auth failed");
      return fail("The launch could not be completed", 500);
    }
    if ("error" in result) return fail(result.error);

    const nonce = randomToken(16);
    const fields: Record<string, string> = { id_token: result.idToken };
    if (result.state !== undefined) fields.state = result.state;
    return sendHtml(
      reply,
      200,
      autoSubmitPage({ action: result.redirectUri, method: "POST", fields, title: "Opening external tool", button: "Continue", nonce }),
      formPageCsp(nonce, allowHttp),
    );
  };

  app.get(
    "/auth",
    {
      config: { tenant: false, rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: { tags: ["LTI"], summary: "OIDC authorization endpoint (LTI 1.3 authentication request)", querystring: zAuthParams },
    },
    (req, reply) => authorize(req, reply, req.query),
  );

  app.post(
    "/auth",
    {
      config: { tenant: false, rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: { tags: ["LTI"], summary: "OIDC authorization endpoint (form post)", body: zAuthParams },
    },
    (req, reply) => authorize(req, reply, req.body),
  );

  // ─── OAuth2 token endpoint (client_credentials + private_key_jwt) ───────

  app.post(
    "/token",
    {
      config: { tenant: false, rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        tags: ["LTI"],
        summary: "OAuth2 access token for LTI Advantage services (client_credentials, JWT client assertion)",
        body: z
          .object({
            grant_type: z.string().max(100),
            client_assertion_type: z.string().max(200),
            client_assertion: z.string().max(8000),
            scope: z.string().max(2000),
          })
          .partial(),
        response: {
          200: z.object({ access_token: z.string(), token_type: z.literal("Bearer"), expires_in: z.number(), scope: z.string() }),
          400: zOAuthError,
          401: zOAuthError,
        },
      },
    },
    async (req, reply) => {
      reply.header("Cache-Control", "no-store").header("Pragma", "no-cache");
      const b = req.body ?? {};
      try {
        if (b.grant_type !== "client_credentials") throw new OAuthError("unsupported_grant_type", "grant_type must be client_credentials");
        if (b.client_assertion_type !== "urn:ietf:params:oauth:client-assertion-type:jwt-bearer" || !b.client_assertion) {
          throw new OAuthError("invalid_client", "A jwt-bearer client_assertion is required", 401);
        }
        const { tool } = await verifyClientAssertion(b.client_assertion);
        const requested = (b.scope ?? "").split(" ").filter(Boolean);
        const granted = requested.filter((s) => tool.scopes.includes(s));
        if (!granted.length) throw new OAuthError("invalid_scope", "None of the requested scopes are enabled for this tool");
        return reply.status(200).send({
          access_token: issueAccessToken({ organizationId: tool.organizationId, toolId: tool.id, clientId: tool.clientId, scopes: granted }),
          token_type: "Bearer" as const,
          expires_in: ACCESS_TOKEN_TTL_SECONDS,
          scope: granted.join(" "),
        });
      } catch (err) {
        if (err instanceof OAuthError) {
          return reply.status(err.status as 400 | 401).send({ error: err.error, error_description: err.message });
        }
        throw err;
      }
    },
  );

  // ─── Assignment and Grade Services (AGS 2.0) ────────────────────────────

  const zLineItem = z.object({
    id: z.string(),
    scoreMaximum: z.number(),
    label: z.string(),
    resourceLinkId: z.string(),
    resourceId: z.string().optional(),
    tag: z.string().optional(),
    startDateTime: z.string().optional(),
    endDateTime: z.string().optional(),
  });

  const lineItemOf = (urls: Awaited<ReturnType<typeof orgInfo>>["urls"], activity: typeof activities.$inferSelect, gradeMax: number) => ({
    id: urls.lineItemUrl(activity.id),
    scoreMaximum: gradeMax,
    label: activity.name,
    resourceLinkId: activity.id,
    ...(activity.availableFrom ? { startDateTime: activity.availableFrom.toISOString() } : {}),
    ...(activity.availableUntil ? { endDateTime: activity.availableUntil.toISOString() } : {}),
  });

  app.get(
    "/ags/:activityId/lineitems",
    {
      config: { tenant: false },
      schema: {
        tags: ["LTI"],
        summary: "AGS line item container (one line item per graded link)",
        params: z.object({ activityId: zId }),
        response: { 200: z.array(zLineItem) },
      },
    },
    async (req, reply) => {
      const token = serviceToken(req, [SCOPES.lineItem, SCOPES.lineItemReadonly, SCOPES.score]);
      const items = await withTenant(token.o, async (tx) => {
        const row = await serviceLink(tx, token, req.params.activityId);
        if (row.link.gradeMax === null) return [];
        const { urls } = await orgInfo(tx, token.o);
        return [lineItemOf(urls, row.activity, row.link.gradeMax)];
      });
      return reply.type(MEDIA.lineItemContainer).send(items);
    },
  );

  app.get(
    "/ags/:activityId/lineitem",
    {
      config: { tenant: false },
      schema: { tags: ["LTI"], summary: "AGS line item", params: z.object({ activityId: zId }), response: { 200: zLineItem } },
    },
    async (req, reply) => {
      const token = serviceToken(req, [SCOPES.lineItem, SCOPES.lineItemReadonly, SCOPES.score]);
      const item = await withTenant(token.o, async (tx) => {
        const row = await serviceLink(tx, token, req.params.activityId);
        if (row.link.gradeMax === null) throw notFound("Line item");
        const { urls } = await orgInfo(tx, token.o);
        return lineItemOf(urls, row.activity, row.link.gradeMax);
      });
      return reply.type(MEDIA.lineItem).send(item);
    },
  );

  const zLineItemInput = z.object({
    scoreMaximum: z.number().positive().max(10_000),
    label: z.string().trim().min(1).max(255),
    resourceLinkId: z.string().max(200).optional(),
    resourceId: z.string().max(200).optional(),
    tag: z.string().max(200).optional(),
  });

  /** Sets the link's line item (one per link): its maximum becomes the activity's grade maximum. */
  const saveLineItem = async (token: AccessToken, activityId: string, body: z.infer<typeof zLineItemInput>, mode: "create" | "update") =>
    withTenant(token.o, async (tx) => {
      const row = await serviceLink(tx, token, activityId);
      if (body.resourceLinkId && body.resourceLinkId !== activityId) throw badRequest("Line items can only belong to this resource link");
      if (mode === "create" && row.link.gradeMax !== null) throw conflict("This resource link already has its line item");
      if (mode === "update" && row.link.gradeMax === null) throw notFound("Line item");
      await tx.update(ltiLinks).set({ gradeMax: body.scoreMaximum }).where(eq(ltiLinks.id, row.link.id));
      await syncActivityGradeItem(tx, row.activity, { gradeMax: body.scoreMaximum, gradePass: null });
      await tx.insert(auditLogs).values({
        organizationId: token.o,
        actorId: null,
        action: mode === "create" ? "lti.lineitem_created" : "lti.lineitem_updated",
        targetType: "activity",
        targetId: activityId,
        metadata: { toolId: token.t, scoreMaximum: body.scoreMaximum, label: body.label },
      });
      const { urls } = await orgInfo(tx, token.o);
      return lineItemOf(urls, row.activity, body.scoreMaximum);
    });

  app.post(
    "/ags/:activityId/lineitems",
    {
      config: { tenant: false, rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        tags: ["LTI"],
        summary: "AGS: create the link's line item (one per resource link)",
        params: z.object({ activityId: zId }),
        body: zLineItemInput,
        response: { 201: zLineItem },
      },
    },
    async (req, reply) => {
      const token = serviceToken(req, [SCOPES.lineItem]);
      const item = await saveLineItem(token, req.params.activityId, req.body, "create");
      return reply.status(201).type(MEDIA.lineItem).send(item);
    },
  );

  app.put(
    "/ags/:activityId/lineitem",
    {
      config: { tenant: false, rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        tags: ["LTI"],
        summary: "AGS: update the line item (scoreMaximum sets the activity's grade maximum)",
        params: z.object({ activityId: zId }),
        body: zLineItemInput,
        response: { 200: zLineItem },
      },
    },
    async (req, reply) => {
      const token = serviceToken(req, [SCOPES.lineItem]);
      const item = await saveLineItem(token, req.params.activityId, req.body, "update");
      return reply.type(MEDIA.lineItem).send(item);
    },
  );

  app.post(
    "/ags/:activityId/lineitem/scores",
    {
      config: { tenant: false, rateLimit: { max: 600, timeWindow: "1 minute" } },
      schema: {
        tags: ["LTI"],
        summary: "AGS score publish (application/vnd.ims.lis.v1.score+json)",
        params: z.object({ activityId: zId }),
        body: z.object({
          userId: z.string().max(200),
          scoreGiven: z.number().min(0).max(1_000_000).nullable().optional(),
          scoreMaximum: z.number().positive().max(1_000_000).nullable().optional(),
          comment: z.string().max(10_000).nullable().optional(),
          timestamp: z.string().datetime({ offset: true }),
          activityProgress: z.enum(ACTIVITY_PROGRESS),
          gradingProgress: z.enum(GRADING_PROGRESS),
        }),
        response: { 204: z.null().describe("Score accepted") },
      },
    },
    async (req, reply) => {
      const token = serviceToken(req, [SCOPES.score]);
      const b = req.body;
      if (req.headers["content-type"]?.split(";")[0]?.trim() !== MEDIA.score) {
        throw new AppError(415, "UNSUPPORTED_MEDIA_TYPE", `Content-Type must be ${MEDIA.score}`);
      }
      let grade: ReturnType<typeof scoreToGrade>;
      await withTenant(token.o, async (tx) => {
        const row = await serviceLink(tx, token, req.params.activityId);
        if (row.link.gradeMax === null) throw notFound("Line item");
        const userId = z.string().uuid().safeParse(b.userId);
        if (!userId.success || !(await isEnrolled(tx, row.course.id, userId.data))) throw badRequest("userId is not a member of this context");

        // AGS: a score older than the last one received for this user must be ignored.
        const tsKey = `lti:score-ts:${row.activity.id}:${userId.data}`;
        const last = await cache.get(tsKey);
        const ts = new Date(b.timestamp).getTime();
        if (last && Number(last) > ts) throw conflict("A newer score has already been received");
        await cache.set(tsKey, String(ts), 90 * 24 * 3600);

        try {
          grade = scoreToGrade(b, row.link.gradeMax);
        } catch (err) {
          throw badRequest(err instanceof Error ? err.message : "Invalid score");
        }
        const base = { organizationId: token.o, activityId: row.activity.id, courseId: row.course.id, userId: userId.data };
        if (grade.kind !== "skip") {
          const payload = await pushGrade(tx, {
            organizationId: token.o,
            activityId: row.activity.id,
            userId: userId.data,
            rawGrade: grade.kind === "set" ? grade.rawGrade : null,
            feedback: b.comment ? escapeHtml(b.comment) : undefined,
            source: "lti",
          });
          if (payload) await emitInTx(tx, "grade.updated", payload);
        }
        await emitInTx(tx, "lti.score", base);
        if (isSubmission(b.activityProgress)) await emitInTx(tx, "activity.submitted", base);
      });
      return reply.status(204).send(null);
    },
  );

  // ─── Names and Role Provisioning Services (NRPS 2.0) ────────────────────

  app.get(
    "/nrps/:activityId/memberships",
    {
      config: { tenant: false, rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        tags: ["LTI"],
        summary: "NRPS context membership (course participants and their LIS roles)",
        params: z.object({ activityId: zId }),
        querystring: z.object({ role: z.string().max(200).optional() }),
        response: {
          200: z.object({
            id: z.string(),
            context: z.object({ id: z.string(), label: z.string(), title: z.string() }),
            members: z.array(
              z.object({
                status: z.literal("Active"),
                user_id: z.string(),
                roles: z.array(z.string()),
                name: z.string().optional(),
                given_name: z.string().optional(),
                family_name: z.string().optional(),
                email: z.string().optional(),
              }),
            ),
          }),
        },
      },
    },
    async (req, reply) => {
      const token = serviceToken(req, [SCOPES.memberships]);
      const out = await withTenant(token.o, async (tx) => {
        const row = await serviceLink(tx, token, req.params.activityId);
        const { urls } = await orgInfo(tx, token.o);
        const people = await tx
          .select({ id: users.id, firstName: users.firstName, lastName: users.lastName, email: users.email })
          .from(enrolments)
          .innerJoin(users, eq(users.id, enrolments.userId))
          .where(and(eq(enrolments.courseId, row.course.id), eq(enrolments.status, "active"), eq(users.status, "active"), isNull(users.deletedAt)))
          .limit(10_000);
        const grants = people.length
          ? await tx
              .select({ userId: roleAssignments.userId, archetype: roles.archetype })
              .from(roleAssignments)
              .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
              .where(and(eq(roleAssignments.contextId, row.course.contextId), inArray(roleAssignments.userId, people.map((p) => p.id))))
          : [];
        const byUser = new Map<string, string[]>();
        for (const g of grants) byUser.set(g.userId, [...(byUser.get(g.userId) ?? []), g.archetype]);
        const share = row.tool.sharePersonalData;
        const members = people
          .map((p) => ({
            status: "Active" as const,
            user_id: p.id,
            roles: rolesForArchetypes(byUser.get(p.id) ?? []),
            ...(share ? { name: `${p.firstName} ${p.lastName}`.trim(), given_name: p.firstName, family_name: p.lastName, email: p.email } : {}),
          }))
          .filter((m) => m.roles.length && (!req.query.role || m.roles.some((r) => r === req.query.role || r.endsWith(`#${req.query.role}`))));
        return {
          id: urls.membershipsUrl(row.activity.id),
          context: { id: row.course.id, label: row.course.shortname, title: row.course.fullname },
          members,
        };
      });
      return reply.type(MEDIA.memberships).send(out);
    },
  );
};
