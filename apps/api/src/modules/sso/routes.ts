import { and, asc, eq, ne } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { getSystemContext, sessions, ssoProviders, type DB, type OidcConfig, type SamlConfig } from "@lms/db";
import { z } from "zod";
import { config } from "../../config";
import { createSession, setSessionCookie } from "../../core/auth";
import { audit } from "../../core/audit";
import { decryptSecret, encryptSecret, maskSecret } from "../../core/crypto";
import { badRequest, must, notFound } from "../../core/errors";
import { requireCapability } from "../../core/rbac";
import { ok, zDate, zId, zIdParam, zOk, patchSchema } from "../../core/schemas";
import { assertSafeEndpoint } from "../../core/storage";
import {
  normalizeCert,
  oidcAuthorizationUrl,
  oidcConfiguration,
  oidcIdentity,
  parseCert,
  providerUrls,
  samlClient,
  samlIdentity,
  samlMetadata,
  spEntityId,
  type OidcState,
} from "./protocols";
import {
  findEnabledProvider,
  isOidc,
  isSaml,
  resolveAccount,
  sanitizeNext,
  signValue,
  SsoError,
  verifySignedValue,
  type ExternalIdentity,
  type SsoProvider,
} from "./service";

const STATE_COOKIE = "lms_sso_state";
const STATE_COOKIE_PATH = "/api/v1/sso";
const STATE_TTL_SECONDS = 10 * 60;
const RESERVED_SLUGS = new Set(["providers"]);

const zSlug = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/, "Lowercase letters, numbers and dashes")
  .refine((s) => !RESERVED_SLUGS.has(s), "This slug is reserved");
const zDomain = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/, "Enter a domain like example.com");

const zOidcInput = z.object({
  issuer: z.string().url().max(500),
  clientId: z.string().trim().min(1).max(500),
  /** Omit on update to keep the stored secret. */
  clientSecret: z.string().min(1).max(2000).optional(),
  scopes: z.string().trim().max(500).optional(),
});
const zSamlInput = z.object({
  entryPoint: z.string().url().max(1000),
  idpIssuer: z.string().trim().max(500).optional(),
  idpCert: z.string().min(100).max(20_000),
  spEntityId: z.string().trim().max(500).optional(),
});

const zProviderFields = {
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean(),
  enforced: z.boolean(),
  autoProvision: z.boolean(),
  allowedDomains: z.array(zDomain).max(50),
};

const zCreate = z.object({
  type: z.enum(["oidc", "saml"]),
  slug: zSlug,
  name: zProviderFields.name,
  enabled: zProviderFields.enabled.default(false),
  enforced: zProviderFields.enforced.default(false),
  autoProvision: zProviderFields.autoProvision.default(false),
  allowedDomains: zProviderFields.allowedDomains.default([]),
  oidc: zOidcInput.optional(),
  saml: zSamlInput.optional(),
});
const zUpdate = z.object({
  slug: zSlug.optional(),
  name: zProviderFields.name.optional(),
  enabled: zProviderFields.enabled.optional(),
  enforced: zProviderFields.enforced.optional(),
  autoProvision: zProviderFields.autoProvision.optional(),
  allowedDomains: zProviderFields.allowedDomains.optional(),
  oidc: patchSchema(zOidcInput).optional(),
  saml: patchSchema(zSamlInput).optional(),
});

const zAdminProvider = z.object({
  id: zId,
  type: z.enum(["oidc", "saml"]),
  slug: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  enforced: z.boolean(),
  autoProvision: z.boolean(),
  allowedDomains: z.array(z.string()),
  oidc: z.object({ issuer: z.string(), clientId: z.string(), clientSecret: z.string().describe("Masked"), scopes: z.string().nullable() }).nullable(),
  saml: z
    .object({
      entryPoint: z.string(),
      idpIssuer: z.string().nullable(),
      idpCert: z.string(),
      spEntityId: z.string().nullable(),
      certificateExpiresAt: z.string().nullable(),
    })
    .nullable(),
  urls: z.object({ login: z.string(), callback: z.string().nullable(), acs: z.string().nullable(), metadata: z.string().nullable(), spEntityId: z.string().nullable() }),
  createdAt: zDate,
  updatedAt: zDate,
});

function certExpiry(body: string) {
  try {
    return new Date(parseCert(body).validTo).toISOString();
  } catch {
    return null;
  }
}

function toAdmin(req: FastifyRequest, p: SsoProvider): z.infer<typeof zAdminProvider> {
  const urls = providerUrls(req, p.slug);
  const oidcCfg = isOidc(p) ? p.config : null;
  const samlCfg = isSaml(p) ? p.config : null;
  let secret = "••••";
  if (oidcCfg) {
    try {
      secret = maskSecret(decryptSecret(oidcCfg.clientSecretEnc));
    } catch {
      // undecryptable (key rotated) — still masked
    }
  }
  return {
    ...p,
    oidc: oidcCfg ? { issuer: oidcCfg.issuer, clientId: oidcCfg.clientId, clientSecret: secret, scopes: oidcCfg.scopes ?? null } : null,
    saml: samlCfg
      ? {
          entryPoint: samlCfg.entryPoint,
          idpIssuer: samlCfg.idpIssuer ?? null,
          idpCert: samlCfg.idpCert,
          spEntityId: samlCfg.spEntityId ?? null,
          certificateExpiresAt: certExpiry(samlCfg.idpCert),
        }
      : null,
    urls: {
      login: urls.login,
      callback: oidcCfg ? urls.callback : null,
      acs: samlCfg ? urls.acs : null,
      metadata: samlCfg ? urls.metadata : null,
      spEntityId: samlCfg ? spEntityId(req, { slug: p.slug, config: samlCfg }) : null,
    },
  };
}

async function requireSsoAdmin(tx: DB, req: FastifyRequest) {
  const system = await getSystemContext(tx, req.org.id);
  await requireCapability(tx, req, "site:manage_sso", system.id);
}

async function buildOidcConfig(input: Partial<z.infer<typeof zOidcInput>>, existing: OidcConfig | null): Promise<OidcConfig> {
  const issuer = input.issuer ?? existing?.issuer;
  const clientId = input.clientId ?? existing?.clientId;
  if (!issuer || !clientId) throw badRequest("OIDC providers need an issuer and a client ID");
  await assertSafeEndpoint(issuer);
  const clientSecretEnc = input.clientSecret ? encryptSecret(input.clientSecret) : existing?.clientSecretEnc;
  if (!clientSecretEnc) throw badRequest("clientSecret is required");
  const scopes = input.scopes !== undefined ? input.scopes || undefined : existing?.scopes;
  return { issuer, clientId, clientSecretEnc, ...(scopes ? { scopes } : {}) };
}

async function buildSamlConfig(input: Partial<z.infer<typeof zSamlInput>>, existing: SamlConfig | null): Promise<SamlConfig> {
  const entryPoint = input.entryPoint ?? existing?.entryPoint;
  const idpCert = input.idpCert !== undefined ? normalizeCert(input.idpCert) : existing?.idpCert;
  if (!entryPoint || !idpCert) throw badRequest("SAML providers need an entry point and the IdP certificate");
  await assertSafeEndpoint(entryPoint);
  try {
    parseCert(idpCert);
  } catch {
    throw badRequest("The IdP certificate is not a valid X.509 certificate");
  }
  const idpIssuer = input.idpIssuer !== undefined ? input.idpIssuer || undefined : existing?.idpIssuer;
  const sp = input.spEntityId !== undefined ? input.spEntityId || undefined : existing?.spEntityId;
  return { entryPoint, idpCert, ...(idpIssuer ? { idpIssuer } : {}), ...(sp ? { spEntityId: sp } : {}) };
}

/** Audit metadata without secrets or certificates. */
const auditMeta = (p: SsoProvider) => ({
  slug: p.slug,
  type: p.type,
  enabled: p.enabled,
  enforced: p.enforced,
  autoProvision: p.autoProvision,
  allowedDomains: p.allowedDomains,
});

// ─── Sign-in helpers ────────────────────────────────────────────────────────

function loginError(reply: FastifyReply, code: string) {
  reply.header("Cache-Control", "no-store");
  return reply.redirect(`/login?error=${encodeURIComponent(code)}`, 302);
}

/** Resolves the account, creates the session and redirects. Errors → /login?error=<code>. */
async function finishLogin(req: FastifyRequest, reply: FastifyReply, provider: SsoProvider, identity: ExternalIdentity, next: string) {
  const previousSession = req.sessionId;
  const token = await req.tenant(async (tx) => {
    const account = await resolveAccount(tx, req.org.id, provider, identity);
    const target = { type: "user", id: account.userId };
    if (account.provisioned) await audit(tx, req, "sso.provisioned", target, { provider: provider.slug });
    else if (account.linked) await audit(tx, req, "sso.linked", target, { provider: provider.slug });
    await audit(tx, req, "sso.login", target, { provider: provider.slug });
    // Replace any ambient session (fresh id → no fixation, no mixing of accounts).
    if (previousSession) await tx.delete(sessions).where(eq(sessions.id, previousSession));
    return createSession(tx, req, account.userId);
  });
  setSessionCookie(reply, token);
  reply.header("Cache-Control", "no-store");
  return reply.redirect(sanitizeNext(next), 302);
}

function handleFailure(req: FastifyRequest, reply: FastifyReply, err: unknown) {
  if (err instanceof SsoError) {
    req.log.warn({ code: err.code, detail: err.message }, "sso login rejected");
    return loginError(reply, err.code);
  }
  // Never echo IdP / library messages to the browser.
  req.log.warn({ err }, "sso login failed");
  return loginError(reply, "sso_failed");
}

const ssoLimit = { rateLimit: { max: 30, timeWindow: "1 minute" } };

export const routes: FastifyPluginAsyncZod = async (app) => {
  // The SAML ACS receives an HTML form post (application/x-www-form-urlencoded). Scoped to this module.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 512 * 1024 }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  // ─── Public ───────────────────────────────────────────────────────────

  app.get(
    "/providers",
    {
      schema: {
        tags: ["SSO"],
        summary: "Enabled sign-in providers (for the login page)",
        response: { 200: z.array(z.object({ slug: z.string(), name: z.string(), type: z.enum(["oidc", "saml"]), enforced: z.boolean() })) },
      },
    },
    (req) =>
      req.tenant((tx) =>
        tx
          .select({ slug: ssoProviders.slug, name: ssoProviders.name, type: ssoProviders.type, enforced: ssoProviders.enforced })
          .from(ssoProviders)
          .where(eq(ssoProviders.enabled, true))
          .orderBy(asc(ssoProviders.name)),
      ),
  );

  // ─── Administration ───────────────────────────────────────────────────

  app.get(
    "/providers/manage",
    { schema: { tags: ["SSO"], summary: "All providers with configuration (secrets masked)", response: { 200: z.array(zAdminProvider) } } },
    (req) =>
      req.tenant(async (tx) => {
        await requireSsoAdmin(tx, req);
        const rows = await tx.select().from(ssoProviders).orderBy(asc(ssoProviders.name));
        return rows.map((p) => toAdmin(req, p));
      }),
  );

  app.post(
    "/providers",
    { schema: { tags: ["SSO"], summary: "Create a provider (the OIDC client secret is encrypted at rest)", body: zCreate, response: { 201: zAdminProvider } } },
    async (req, reply) => {
      const body = req.body;
      const created = await req.tenant(async (tx) => {
        await requireSsoAdmin(tx, req);
        let cfg: OidcConfig | SamlConfig;
        if (body.type === "oidc") {
          if (!body.oidc) throw badRequest("OIDC settings are required");
          cfg = await buildOidcConfig(body.oidc, null);
        } else {
          if (!body.saml) throw badRequest("SAML settings are required");
          cfg = await buildSamlConfig(body.saml, null);
        }
        const [row] = await tx
          .insert(ssoProviders)
          .values({
            organizationId: req.org.id,
            type: body.type,
            slug: body.slug,
            name: body.name,
            enabled: body.enabled,
            enforced: body.enforced,
            autoProvision: body.autoProvision,
            allowedDomains: body.allowedDomains,
            config: cfg,
          })
          .returning();
        await audit(tx, req, "sso.provider_created", { type: "sso_provider", id: row!.id }, auditMeta(row!));
        return row!;
      });
      return reply.status(201).send(toAdmin(req, created));
    },
  );

  app.patch(
    "/providers/:id",
    { schema: { tags: ["SSO"], summary: "Update a provider (omit clientSecret to keep it)", params: zIdParam, body: zUpdate, response: { 200: zAdminProvider } } },
    async (req) => {
      const updated = await req.tenant(async (tx) => {
        await requireSsoAdmin(tx, req);
        const current = must((await tx.select().from(ssoProviders).where(eq(ssoProviders.id, req.params.id)).limit(1))[0], "Provider");
        const { oidc, saml, ...fields } = req.body;
        let cfg = current.config;
        if (isOidc(current) && oidc) cfg = await buildOidcConfig(oidc, current.config);
        if (isSaml(current) && saml) cfg = await buildSamlConfig(saml, current.config);
        if (fields.slug && fields.slug !== current.slug) {
          const [clash] = await tx
            .select({ id: ssoProviders.id })
            .from(ssoProviders)
            .where(and(eq(ssoProviders.slug, fields.slug), ne(ssoProviders.id, current.id)))
            .limit(1);
          if (clash) throw badRequest("Another provider already uses this slug");
        }
        const [row] = await tx
          .update(ssoProviders)
          .set({ ...fields, config: cfg, updatedAt: new Date() })
          .where(eq(ssoProviders.id, current.id))
          .returning();
        await audit(tx, req, "sso.provider_updated", { type: "sso_provider", id: row!.id }, {
          ...auditMeta(row!),
          fields: Object.keys(req.body),
          secretChanged: !!oidc?.clientSecret,
        });
        return row!;
      });
      return toAdmin(req, updated);
    },
  );

  app.delete(
    "/providers/:id",
    { schema: { tags: ["SSO"], summary: "Delete a provider and its linked identities", params: zIdParam, response: { 200: zOk } } },
    async (req) => {
      await req.tenant(async (tx) => {
        await requireSsoAdmin(tx, req);
        const current = must((await tx.select().from(ssoProviders).where(eq(ssoProviders.id, req.params.id)).limit(1))[0], "Provider");
        await tx.delete(ssoProviders).where(eq(ssoProviders.id, current.id));
        await audit(tx, req, "sso.provider_deleted", { type: "sso_provider", id: current.id }, auditMeta(current));
      });
      return ok;
    },
  );

  app.post(
    "/providers/:id/test",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["SSO"],
        summary: "Test a provider: OIDC discovery, or SAML certificate check",
        params: zIdParam,
        response: { 200: z.object({ ok: z.boolean(), message: z.string() }) },
      },
    },
    async (req) => {
      const provider = await req.tenant(async (tx) => {
        await requireSsoAdmin(tx, req);
        return must((await tx.select().from(ssoProviders).where(eq(ssoProviders.id, req.params.id)).limit(1))[0], "Provider");
      });
      if (isSaml(provider)) {
        try {
          const cert = parseCert(provider.config.idpCert);
          const expired = new Date(cert.validTo) < new Date();
          return expired
            ? { ok: false, message: `The IdP certificate expired on ${new Date(cert.validTo).toISOString().slice(0, 10)}` }
            : { ok: true, message: `Certificate valid until ${new Date(cert.validTo).toISOString().slice(0, 10)}` };
        } catch {
          return { ok: false, message: "The IdP certificate could not be parsed" };
        }
      }
      if (!isOidc(provider)) return { ok: false, message: "Unknown provider type" };
      try {
        const cfg = await oidcConfiguration(provider, { fresh: true });
        return { ok: true, message: `Discovered ${cfg.serverMetadata().issuer}` };
      } catch (err) {
        // Generic class of error only: raw messages can echo internal details.
        const name = (err as { name?: string }).name ?? "Error";
        return { ok: false, message: `Discovery failed (${name})` };
      }
    },
  );

  // ─── Sign-in flows ────────────────────────────────────────────────────

  app.get(
    "/:slug/login",
    {
      config: ssoLimit,
      schema: {
        tags: ["SSO"],
        summary: "Start single sign-on (302 to the identity provider)",
        params: z.object({ slug: z.string().max(40) }),
        querystring: z.object({ next: z.string().max(1000).optional() }),
      },
    },
    async (req, reply) => {
      const next = sanitizeNext(req.query.next);
      try {
        const provider = await req.tenant((tx) => findEnabledProvider(tx, req.params.slug));
        if (!provider) return loginError(reply, "sso_unavailable");
        reply.header("Cache-Control", "no-store");
        if (isOidc(provider)) {
          const cfg = await oidcConfiguration(provider);
          const { url, state, nonce, verifier } = await oidcAuthorizationUrl(cfg, provider, providerUrls(req, provider.slug).callback);
          const payload: OidcState = { p: provider.id, s: state, n: nonce, v: verifier, next };
          reply.setCookie(STATE_COOKIE, signValue(payload, STATE_TTL_SECONDS), {
            httpOnly: true,
            secure: config.isProd,
            sameSite: "lax",
            path: STATE_COOKIE_PATH,
            maxAge: STATE_TTL_SECONDS,
          });
          return reply.redirect(url.href, 302);
        }
        if (isSaml(provider)) {
          // RelayState is echoed back by the IdP on the cross-site POST, so `next` travels signed in it.
          const relayState = signValue({ p: provider.id, next }, STATE_TTL_SECONDS);
          const url = await samlClient(req, provider).getAuthorizeUrlAsync(relayState, {});
          return reply.redirect(url, 302);
        }
        return loginError(reply, "sso_unavailable");
      } catch (err) {
        return handleFailure(req, reply, err);
      }
    },
  );

  app.get(
    "/:slug/callback",
    {
      config: ssoLimit,
      schema: {
        tags: ["SSO"],
        summary: "OIDC redirect URI (validates code, state, nonce and PKCE; 302 to the app)",
        params: z.object({ slug: z.string().max(40) }),
        querystring: z.record(z.string(), z.string()),
      },
    },
    async (req, reply) => {
      const raw = req.cookies[STATE_COOKIE];
      reply.clearCookie(STATE_COOKIE, { path: STATE_COOKIE_PATH });
      try {
        const state = verifySignedValue<OidcState>(raw);
        if (!state) throw new SsoError("sso_state", "missing or invalid state cookie");
        if (req.query.error) throw new SsoError("sso_failed", `IdP returned error ${req.query.error.slice(0, 100)}`);
        const provider = await req.tenant((tx) => findEnabledProvider(tx, req.params.slug));
        if (!provider || !isOidc(provider)) throw new SsoError("sso_unavailable");
        if (provider.id !== state.p) throw new SsoError("sso_state", "state issued for another provider");
        const cfg = await oidcConfiguration(provider);
        const currentUrl = new URL(providerUrls(req, provider.slug).callback);
        currentUrl.search = new URL(req.url, "http://callback.invalid").search;
        const identity = await oidcIdentity(cfg, currentUrl, { state: state.s, nonce: state.n, verifier: state.v });
        return await finishLogin(req, reply, provider, identity, state.next);
      } catch (err) {
        return handleFailure(req, reply, err);
      }
    },
  );

  app.post(
    "/:slug/acs",
    {
      config: ssoLimit,
      // Cross-site POST from the IdP. The CSRF origin check (core/auth) only applies to cookie-authenticated
      // requests; SameSite=Lax means the session cookie isn't sent on this POST, and we also drop any ambient
      // session here so a same-site IdP can't trip it. The signed assertion + InResponseTo are the protection.
      preValidation: async (req) => {
        req.authVia = null;
        req.user = null;
      },
      schema: {
        tags: ["SSO"],
        summary: "SAML assertion consumer service (HTTP-POST binding; 302 to the app)",
        params: z.object({ slug: z.string().max(40) }),
        body: z.object({ SAMLResponse: z.string().min(1).max(500_000), RelayState: z.string().max(4000).optional() }),
      },
    },
    async (req, reply) => {
      try {
        const relay = verifySignedValue<{ p: string; next: string }>(req.body.RelayState);
        if (!relay) throw new SsoError("sso_state", "missing or invalid RelayState");
        const provider = await req.tenant((tx) => findEnabledProvider(tx, req.params.slug));
        if (!provider || !isSaml(provider)) throw new SsoError("sso_unavailable");
        if (provider.id !== relay.p) throw new SsoError("sso_state", "RelayState issued for another provider");
        const { profile } = await samlClient(req, provider).validatePostResponseAsync({
          SAMLResponse: req.body.SAMLResponse,
          ...(req.body.RelayState ? { RelayState: req.body.RelayState } : {}),
        });
        if (!profile) throw new SsoError("sso_failed", "no profile in SAML response");
        return await finishLogin(req, reply, provider, samlIdentity(profile), relay.next);
      } catch (err) {
        return handleFailure(req, reply, err);
      }
    },
  );

  app.get(
    "/:slug/metadata",
    {
      schema: { tags: ["SSO"], summary: "SAML service provider metadata (XML) to give the IdP", params: z.object({ slug: z.string().max(40) }) },
    },
    async (req, reply) => {
      const provider = await req.tenant(async (tx) =>
        must((await tx.select().from(ssoProviders).where(eq(ssoProviders.slug, req.params.slug)).limit(1))[0], "Provider"),
      );
      if (!isSaml(provider)) throw notFound("Provider");
      return reply.type("application/samlmetadata+xml; charset=utf-8").header("Cache-Control", "no-store").send(samlMetadata(req, provider));
    },
  );
};
