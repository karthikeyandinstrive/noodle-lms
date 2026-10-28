import { and, eq } from "drizzle-orm";
import { createRemoteJWKSet, customFetch, decodeJwt, errors as joseErrors, jwtVerify, type JWTPayload } from "jose";
import { gradeItems, ltiLinks, ltiTools, organizations, systemDb, type DB } from "@lms/db";
import { z } from "zod";
import { config } from "../../config";
import { registerActivityType, type ActivityRow } from "../../core/activity-types";
import { hmac, randomToken, safeEqual } from "../../core/crypto";
import { badRequest } from "../../core/errors";
import { redis } from "../../core/redis";
import { zId } from "../../core/schemas";
import { assertSafeEndpoint } from "../../core/storage";
import { recalculateCourseTotals, syncActivityGradeItem } from "../gradebook/service";
import { CUSTOM_KEY, SUPPORTED_SCOPES } from "./claims";

export type ToolRow = typeof ltiTools.$inferSelect;
export type LinkRow = typeof ltiLinks.$inferSelect;

// ─── Public URLs ────────────────────────────────────────────────────────────

/**
 * Public base URL of an organization, used as our LTI issuer and for every service URL.
 * Custom domain → https://<domain>; SaaS subdomain → <slug>.BASE_DOMAIN; else APP_URL.
 * It must be the host where users' session cookies live, so /lti/auth (on this host)
 * can see the session on GET.
 */
export function orgBaseUrl(org: { slug: string; customDomain: string | null }) {
  const app = new URL(config.APP_URL);
  if (org.customDomain) return `${config.isProd ? "https:" : app.protocol}//${org.customDomain}`;
  if (config.SAAS_MODE && org.slug !== config.DEFAULT_ORG_SLUG && config.BASE_DOMAIN !== "localhost") {
    return `${app.protocol}//${org.slug}.${config.BASE_DOMAIN}${app.port ? `:${app.port}` : ""}`;
  }
  return config.APP_URL.replace(/\/+$/, "");
}

export function platformUrls(base: string, organizationId: string) {
  const api = `${base}/api/v1/lti`;
  return {
    issuer: base,
    authUrl: `${api}/auth`,
    tokenUrl: `${api}/token`,
    jwksUrl: `${api}/jwks/${organizationId}`,
    lineItemsUrl: (activityId: string) => `${api}/ags/${activityId}/lineitems`,
    lineItemUrl: (activityId: string) => `${api}/ags/${activityId}/lineitem`,
    membershipsUrl: (activityId: string) => `${api}/nrps/${activityId}/memberships`,
    deepLinkReturnUrl: `${api}/deep-link/return`,
    returnUrl: (activityId: string) => `${base}/activities/${activityId}`,
  };
}

export async function orgInfo(tx: DB, organizationId: string) {
  const [org] = await tx
    .select({ id: organizations.id, name: organizations.name, slug: organizations.slug, customDomain: organizations.customDomain })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  if (!org) throw badRequest("Unknown organization");
  const base = orgBaseUrl(org);
  return { ...org, base, urls: platformUrls(base, org.id) };
}

// ─── Tool registry ──────────────────────────────────────────────────────────

/** Tool endpoints are fetched (JWKS) or navigated to: https in production and never private addresses. */
export async function assertToolUrl(url: string, label: string) {
  try {
    await assertSafeEndpoint(url);
  } catch (err) {
    throw badRequest(`${label}: ${err instanceof Error ? err.message : "invalid URL"}`);
  }
}

/** Redirect URIs are only navigated to by the browser (no SSRF), but must be absolute http(s) (https in production). */
export function assertRedirectUri(uri: string) {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw badRequest(`Invalid redirect URI: ${uri.slice(0, 100)}`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && !config.isProd)) throw badRequest("Redirect URIs must use https");
  if (url.hash) throw badRequest("Redirect URIs must not contain a fragment");
}

export const newClientId = () => randomToken(18);
export const newDeploymentId = () => crypto.randomUUID();

export function normalizeScopes(scopes: string[]) {
  return [...new Set(scopes.filter((s) => SUPPORTED_SCOPES.includes(s)))];
}

export async function toolById(tx: DB, id: string) {
  const [row] = await tx.select().from(ltiTools).where(eq(ltiTools.id, id)).limit(1);
  return row ?? null;
}

export async function linkOf(tx: DB, activityId: string) {
  const [row] = await tx
    .select({ link: ltiLinks, tool: ltiTools })
    .from(ltiLinks)
    .innerJoin(ltiTools, eq(ltiTools.id, ltiLinks.toolId))
    .where(eq(ltiLinks.activityId, activityId))
    .limit(1);
  return row ?? null;
}

// ─── Activity type ──────────────────────────────────────────────────────────

const customParams = z
  .record(z.string(), z.string().max(4000))
  .refine((m) => Object.keys(m).length <= 50 && Object.keys(m).every((k) => CUSTOM_KEY.test(k)), {
    message: "Custom parameter names may contain letters, digits, '_', '.' and '-' (max 50 parameters)",
  });

const settings = z.object({
  toolId: zId,
  targetLinkUri: z.string().trim().max(2000).nullable().optional(),
  customParams: customParams.default({}),
  /** null = ungraded (no AGS line item). */
  gradeMax: z.number().min(0.01).max(10_000).nullable().default(null),
  openInNewWindow: z.boolean().default(false),
});

async function assertUsableTool(tx: DB, toolId: string) {
  const tool = await toolById(tx, toolId);
  if (!tool || !tool.enabled) throw badRequest("Choose an enabled external tool");
  return tool;
}

function checkTargetLink(uri: string | null | undefined) {
  if (!uri) return null;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw badRequest("The launch URL must be a valid URL");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && !config.isProd)) throw badRequest("The launch URL must use https");
  return url.toString();
}

export function setupLtiActivity() {
  registerActivityType({
    type: "lti",
    label: "External tool",
    settings,
    async create(tx, { activity }, s) {
      await assertUsableTool(tx, s.toolId);
      await tx.insert(ltiLinks).values({
        organizationId: activity.organizationId,
        activityId: activity.id,
        toolId: s.toolId,
        targetLinkUri: checkTargetLink(s.targetLinkUri),
        customParams: s.customParams ?? {},
        gradeMax: s.gradeMax ?? null,
        openInNewWindow: s.openInNewWindow ?? false,
      });
      await syncGradeItem(tx, activity, s.gradeMax ?? null);
    },
    async update(tx, { activity }, s) {
      const [row] = await tx.select().from(ltiLinks).where(eq(ltiLinks.activityId, activity.id)).limit(1);
      if (!row) throw badRequest("External tool settings are missing");
      const patch: Partial<typeof ltiLinks.$inferInsert> = {};
      if (s.toolId !== undefined && s.toolId !== row.toolId) {
        await assertUsableTool(tx, s.toolId);
        patch.toolId = s.toolId;
      }
      if (s.targetLinkUri !== undefined) patch.targetLinkUri = checkTargetLink(s.targetLinkUri);
      if (s.customParams !== undefined) patch.customParams = s.customParams;
      if (s.gradeMax !== undefined) patch.gradeMax = s.gradeMax;
      if (s.openInNewWindow !== undefined) patch.openInNewWindow = s.openInNewWindow;
      if (Object.keys(patch).length) await tx.update(ltiLinks).set(patch).where(eq(ltiLinks.id, row.id));
      // Also keeps the grade item's name/visibility in sync after an edit.
      await syncGradeItem(tx, activity, s.gradeMax !== undefined ? s.gradeMax : row.gradeMax);
    },
    async load(tx, activity) {
      const row = await linkOf(tx, activity.id);
      if (!row) return null;
      // Custom parameters are not secret: they travel in the id_token through the user's browser anyway.
      return {
        toolId: row.link.toolId,
        toolName: row.tool.name,
        toolEnabled: row.tool.enabled,
        targetLinkUri: row.link.targetLinkUri,
        customParams: row.link.customParams,
        gradeMax: row.link.gradeMax,
        openInNewWindow: row.link.openInNewWindow,
      };
    },
  });
}

/**
 * The handler contract has a static `grading()`, but an LTI link is only gradable when
 * `gradeMax` is set (AGS line item). So the type registers no `grading()` and keeps the
 * grade item in sync itself: created/updated when gradeMax is set, removed when the
 * teacher makes the link ungraded.
 */
async function syncGradeItem(tx: DB, activity: ActivityRow, gradeMax: number | null) {
  if (gradeMax !== null) {
    await syncActivityGradeItem(tx, activity, { gradeMax, gradePass: null });
    return;
  }
  const deleted = await tx.delete(gradeItems).where(eq(gradeItems.activityId, activity.id)).returning({ id: gradeItems.id });
  if (deleted.length) await recalculateCourseTotals(tx, { organizationId: activity.organizationId, courseId: activity.courseId });
}

// ─── OAuth2 access tokens for LTI services ──────────────────────────────────

export const ACCESS_TOKEN_TTL_SECONDS = 3600;

export type AccessToken = { o: string; t: string; c: string; s: string[]; e: number };

/** Opaque-to-the-tool, HMAC-signed (URL_SIGNING_SECRET) access token: `lti1.<payload>.<sig>`. */
export function issueAccessToken(input: { organizationId: string; toolId: string; clientId: string; scopes: string[] }, now = Date.now()) {
  const payload: AccessToken = {
    o: input.organizationId,
    t: input.toolId,
    c: input.clientId,
    s: input.scopes,
    e: Math.floor(now / 1000) + ACCESS_TOKEN_TTL_SECONDS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `lti1.${body}.${hmac(`lti-access:${body}`)}`;
}

export function verifyAccessToken(token: string | undefined, now = Date.now()): AccessToken | null {
  if (!token) return null;
  const [prefix, body, sig] = token.split(".");
  if (prefix !== "lti1" || !body || !sig || !safeEqual(sig, hmac(`lti-access:${body}`))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as AccessToken;
    if (typeof p.e !== "number" || p.e < now / 1000 || !Array.isArray(p.s)) return null;
    return p;
  } catch {
    return null;
  }
}

export function bearerOf(header: string | undefined) {
  if (!header) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m?.[1]?.trim();
}

// ─── Client assertion (private_key_jwt) ─────────────────────────────────────

type RemoteSet = ReturnType<typeof createRemoteJWKSet>;
const jwksSets = new Map<string, { set: RemoteSet; at: number }>();
const JWKS_SET_TTL_MS = 60 * 60 * 1000;

/** Remote JWKS per tool URL (cached). Each fetch re-runs the SSRF check; redirects are not followed by jose. */
async function remoteJwks(url: string): Promise<RemoteSet> {
  const hit = jwksSets.get(url);
  if (hit && Date.now() - hit.at < JWKS_SET_TTL_MS) return hit.set;
  await assertSafeEndpoint(url);
  const set = createRemoteJWKSet(new URL(url), {
    timeoutDuration: 5000,
    cooldownDuration: 30_000,
    cacheMaxAge: 10 * 60_000,
    [customFetch]: async (input: string | URL | Request, init?: RequestInit) => {
      await assertSafeEndpoint(String(input instanceof Request ? input.url : input));
      return fetch(input, init);
    },
  });
  if (jwksSets.size > 1000) jwksSets.clear();
  jwksSets.set(url, { set, at: Date.now() });
  return set;
}

const memoryJti = new Map<string, number>();

/** Single use of a client assertion's jti (Redis SET NX when available, else in-memory LRU). */
export async function claimJti(key: string, ttlSeconds: number): Promise<boolean> {
  const ttl = Math.max(60, Math.min(ttlSeconds, 24 * 3600));
  if (redis) return (await redis.set(`lti:jti:${key}`, "1", "EX", ttl, "NX")) === "OK";
  const now = Date.now();
  const exp = memoryJti.get(key);
  if (exp && exp > now) return false;
  memoryJti.delete(key);
  memoryJti.set(key, now + ttl * 1000);
  if (memoryJti.size > 10_000) {
    for (const [k, e] of memoryJti) {
      if (e <= now || memoryJti.size > 10_000) memoryJti.delete(k);
      if (memoryJti.size <= 9_000) break;
    }
  }
  return true;
}

export class OAuthError extends Error {
  constructor(
    public readonly error: "invalid_request" | "invalid_client" | "invalid_grant" | "invalid_scope" | "unsupported_grant_type",
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

/**
 * Verifies a JWT the tool signed for this platform (e.g. a Deep Linking response):
 * iss = the tool's client_id, aud = our issuer, signed by a key in the tool's JWKS.
 */
export async function verifyToolMessage(jwt: string): Promise<{ tool: ToolRow; payload: JWTPayload }> {
  let unverified: JWTPayload;
  try {
    unverified = decodeJwt(jwt);
  } catch {
    throw new Error("The tool's response is not a JWT");
  }
  const clientId = typeof unverified.iss === "string" ? unverified.iss : "";
  if (!clientId || clientId.length > 200) throw new Error("Unknown tool");
  const db = await systemDb();
  // client_id is globally unique; the only cross-tenant read, everything after runs in the tenant.
  const [tool] = await db.select().from(ltiTools).where(and(eq(ltiTools.clientId, clientId), eq(ltiTools.enabled, true))).limit(1);
  if (!tool) throw new Error("Unknown tool");
  const [org] = await db
    .select({ slug: organizations.slug, customDomain: organizations.customDomain })
    .from(organizations)
    .where(eq(organizations.id, tool.organizationId))
    .limit(1);
  const issuers = [...new Set([platformUrls(orgBaseUrl(org!), tool.organizationId).issuer, config.APP_URL.replace(/\/+$/, "")])];
  try {
    const { payload } = await jwtVerify(jwt, await remoteJwks(tool.jwksUrl), {
      issuer: clientId,
      audience: issuers,
      algorithms: ["RS256", "RS384", "RS512", "PS256", "ES256"],
      maxTokenAge: "1h",
      clockTolerance: 60,
      requiredClaims: ["exp", "iat"],
    });
    return { tool, payload };
  } catch (err) {
    throw new Error(`The tool's response could not be verified (${err instanceof joseErrors.JOSEError ? err.code : "invalid"})`);
  }
}

/** Finds the tool for a client assertion and verifies it (iss = sub = client_id, aud = token URL, jti single use). */
export async function verifyClientAssertion(assertion: string): Promise<{ tool: ToolRow; payload: JWTPayload }> {
  let unverified: JWTPayload;
  try {
    unverified = decodeJwt(assertion);
  } catch {
    throw new OAuthError("invalid_client", "client_assertion is not a JWT", 401);
  }
  const clientId = typeof unverified.iss === "string" ? unverified.iss : "";
  if (!clientId || clientId.length > 200) throw new OAuthError("invalid_client", "Unknown client", 401);
  const db = await systemDb();
  // client_id is globally unique; this lookup is the only cross-tenant read (like a session lookup).
  const [tool] = await db.select().from(ltiTools).where(and(eq(ltiTools.clientId, clientId), eq(ltiTools.enabled, true))).limit(1);
  if (!tool) throw new OAuthError("invalid_client", "Unknown client", 401);

  const [org] = await db
    .select({ slug: organizations.slug, customDomain: organizations.customDomain })
    .from(organizations)
    .where(eq(organizations.id, tool.organizationId))
    .limit(1);
  const tokenUrls = [...new Set([platformUrls(orgBaseUrl(org!), tool.organizationId).tokenUrl, `${config.APP_URL.replace(/\/+$/, "")}/api/v1/lti/token`])];

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(assertion, await remoteJwks(tool.jwksUrl), {
      issuer: clientId,
      subject: clientId,
      audience: tokenUrls,
      algorithms: ["RS256", "RS384", "RS512", "PS256", "ES256"],
      maxTokenAge: "1h",
      clockTolerance: 60,
      requiredClaims: ["exp", "iat", "jti"],
    }));
  } catch (err) {
    const msg = err instanceof joseErrors.JOSEError ? err.code : "verification failed";
    throw new OAuthError("invalid_client", `Invalid client assertion (${msg})`, 401);
  }
  const ttl = (payload.exp ?? 0) - Math.floor(Date.now() / 1000) + 60;
  if (!(await claimJti(`${clientId}:${String(payload.jti).slice(0, 200)}`, ttl))) {
    throw new OAuthError("invalid_client", "client_assertion has already been used", 401);
  }
  return { tool, payload };
}
