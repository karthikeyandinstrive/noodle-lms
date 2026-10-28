import { X509Certificate } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { SAML, ValidateInResponseTo, generateServiceProviderMetadata, type CacheItem, type CacheProvider, type Profile } from "@node-saml/node-saml";
import * as oidc from "openid-client";
import type { OidcConfig, SamlConfig } from "@lms/db";
import { config } from "../../config";
import { decryptSecret } from "../../core/crypto";
import { redis } from "../../core/redis";
import { assertSafeEndpoint } from "../../core/storage";
import type { ExternalIdentity, SsoProvider } from "./service";

// ─── URLs given to the IdP ──────────────────────────────────────────────────

/** Public origin of this tenant as the browser sees it (X-Forwarded-* honoured behind the web proxy). */
export const publicOrigin = (req: FastifyRequest) => `${req.protocol}://${req.host}`;

export function providerUrls(req: FastifyRequest, slug: string) {
  const base = `${publicOrigin(req)}/api/v1/sso/${encodeURIComponent(slug)}`;
  return { login: `${base}/login`, callback: `${base}/callback`, acs: `${base}/acs`, metadata: `${base}/metadata` };
}

// ─── OIDC (openid-client v6) ────────────────────────────────────────────────

const discoveryCache = new Map<string, { cfg: oidc.Configuration; expires: number }>();
const DISCOVERY_TTL_MS = 10 * 60_000;

/** Runs OIDC discovery (cached 10 min per provider version). Every discovered endpoint must be public. */
export async function oidcConfiguration(provider: Pick<SsoProvider, "id" | "updatedAt"> & { config: OidcConfig }, opts: { fresh?: boolean } = {}) {
  const key = `${provider.id}:${provider.updatedAt.getTime()}`;
  const hit = discoveryCache.get(key);
  if (!opts.fresh && hit && hit.expires > Date.now()) return hit.cfg;

  const issuer = new URL(provider.config.issuer);
  await assertSafeEndpoint(issuer.toString());
  const insecure = issuer.protocol === "http:" && !config.isProd;
  const cfg = await oidc.discovery(issuer, provider.config.clientId, decryptSecret(provider.config.clientSecretEnc), undefined, {
    timeout: 10,
    ...(insecure ? { execute: [oidc.allowInsecureRequests] } : {}),
  });
  const meta = cfg.serverMetadata();
  for (const url of [meta.authorization_endpoint, meta.token_endpoint, meta.jwks_uri, meta.userinfo_endpoint]) {
    if (url) await assertSafeEndpoint(url);
  }
  for (const [k, v] of discoveryCache) if (k.startsWith(`${provider.id}:`)) discoveryCache.delete(k);
  discoveryCache.set(key, { cfg, expires: Date.now() + DISCOVERY_TTL_MS });
  return cfg;
}

export type OidcState = { p: string; s: string; n: string; v: string; next: string };

export async function oidcAuthorizationUrl(cfg: oidc.Configuration, provider: { config: OidcConfig }, redirectUri: string) {
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const verifier = oidc.randomPKCECodeVerifier();
  const url = oidc.buildAuthorizationUrl(cfg, {
    redirect_uri: redirectUri,
    scope: provider.config.scopes?.trim() || "openid email profile",
    response_type: "code",
    state,
    nonce,
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
    code_challenge_method: "S256",
  });
  return { url, state, nonce, verifier };
}

const asBool = (v: unknown) => (v === true || v === "true" ? true : v === false || v === "false" ? false : undefined);
const asString = (v: unknown) => (typeof v === "string" && v.length ? v : undefined);

/** Exchanges the code (PKCE + state + nonce checked) and returns the identity. */
export async function oidcIdentity(cfg: oidc.Configuration, currentUrl: URL, checks: { state: string; nonce: string; verifier: string }): Promise<ExternalIdentity> {
  const tokens = await oidc.authorizationCodeGrant(cfg, currentUrl, {
    pkceCodeVerifier: checks.verifier,
    expectedState: checks.state,
    expectedNonce: checks.nonce,
    idTokenExpected: true,
  });
  const claims = tokens.claims();
  if (!claims?.sub) throw new Error("ID token without subject");
  let source: Record<string, unknown> = claims;
  if (!asString(claims.email)) {
    // Some IdPs only put the email in the UserInfo response.
    source = { ...(await oidc.fetchUserInfo(cfg, tokens.access_token, claims.sub)), sub: claims.sub };
  }
  return {
    subject: claims.sub,
    email: asString(source.email),
    emailVerified: asBool(source.email_verified),
    firstName: asString(source.given_name) ?? asString(source.name),
    lastName: asString(source.family_name),
  };
}

// ─── SAML (@node-saml/node-saml v5) ─────────────────────────────────────────

const REQUEST_TTL_MS = 10 * 60_000;
const memory = new Map<string, { value: string; createdAt: number; expires: number }>();

function sweep() {
  const now = Date.now();
  for (const [k, v] of memory) if (v.expires < now) memory.delete(k);
}

/**
 * Stores AuthnRequest ids (InResponseTo validation) and seen assertion ids
 * (replay protection). Redis when configured (needed with several API
 * instances), otherwise process memory.
 */
class SamlCache implements CacheProvider {
  constructor(private readonly prefix: string) {}
  private k(key: string) {
    return `saml:${this.prefix}:${key}`;
  }
  async saveAsync(key: string, value: string): Promise<CacheItem | null> {
    const createdAt = Date.now();
    if (redis) await redis.set(this.k(key), value, "PX", REQUEST_TTL_MS);
    else {
      sweep();
      memory.set(this.k(key), { value, createdAt, expires: createdAt + REQUEST_TTL_MS });
    }
    return { value, createdAt };
  }
  async getAsync(key: string) {
    if (redis) return redis.get(this.k(key));
    const hit = memory.get(this.k(key));
    return hit && hit.expires >= Date.now() ? hit.value : null;
  }
  async removeAsync(key: string | null) {
    if (key === null) return null;
    return this.consumeAsync(key);
  }
  async consumeAsync(key: string) {
    if (redis) return redis.getdel(this.k(key));
    const value = await this.getAsync(key);
    memory.delete(this.k(key));
    return value;
  }
  async saveIfAbsentAsync(key: string, value: string, expiresAtMs: number) {
    const ttl = Math.max(1, expiresAtMs - Date.now());
    if (redis) return (await redis.set(this.k(key), value, "PX", ttl, "NX")) === "OK";
    if ((await this.getAsync(key)) !== null) return false;
    memory.set(this.k(key), { value, createdAt: Date.now(), expires: Date.now() + ttl });
    return true;
  }
}

/** PEM body (base64) without headers or whitespace. */
export function normalizeCert(input: string) {
  return input
    .replace(/-----(BEGIN|END) CERTIFICATE-----/g, "")
    .replace(/\s+/g, "");
}

export function parseCert(body: string) {
  const pem = `-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/g)?.join("\n") ?? ""}\n-----END CERTIFICATE-----\n`;
  return new X509Certificate(pem);
}

export const spEntityId = (req: FastifyRequest, provider: Pick<SsoProvider, "slug"> & { config: SamlConfig }) =>
  provider.config.spEntityId?.trim() || providerUrls(req, provider.slug).metadata;

export function samlClient(req: FastifyRequest, provider: Pick<SsoProvider, "id" | "slug"> & { config: SamlConfig }) {
  const entityId = spEntityId(req, provider);
  return new SAML({
    entryPoint: provider.config.entryPoint,
    issuer: entityId,
    audience: entityId,
    callbackUrl: providerUrls(req, provider.slug).acs,
    idpCert: provider.config.idpCert,
    ...(provider.config.idpIssuer ? { idpIssuer: provider.config.idpIssuer } : {}),
    identifierFormat: null,
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    acceptedClockSkewMs: 5_000,
    maxAssertionAgeMs: 10 * 60_000,
    // SP-initiated only: the response must answer a request we issued, and each assertion is accepted once.
    validateInResponseTo: ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: REQUEST_TTL_MS,
    rejectReplayedAssertions: true,
    cacheProvider: new SamlCache(provider.id),
    disableRequestedAuthnContext: true,
  });
}

export function samlMetadata(req: FastifyRequest, provider: Pick<SsoProvider, "slug"> & { config: SamlConfig }) {
  return generateServiceProviderMetadata({
    issuer: spEntityId(req, provider),
    callbackUrl: providerUrls(req, provider.slug).acs,
    wantAssertionsSigned: true,
    identifierFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
  });
}

const EMAIL_ATTRIBUTES = [
  "email",
  "mail",
  "urn:oid:0.9.2342.19200300.100.1.3",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
  "emailAddress",
];
const first = (v: unknown) => asString(Array.isArray(v) ? v[0] : v);

/** Email from a standard attribute, else the NameID when it is an email address. */
export function samlIdentity(profile: Profile): ExternalIdentity {
  const fromAttr = EMAIL_ATTRIBUTES.map((a) => first(profile[a])).find(Boolean);
  const email = fromAttr ?? (/^[^\s@]+@[^\s@]+$/.test(profile.nameID) ? profile.nameID : undefined);
  return {
    subject: profile.nameID,
    email,
    // The assertion is signed by the IdP the admin configured: its email is trusted.
    emailVerified: true,
    firstName:
      first(profile.givenName) ?? first(profile["urn:oid:2.5.4.42"]) ?? first(profile["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname"]),
    lastName: first(profile.sn) ?? first(profile["urn:oid:2.5.4.4"]) ?? first(profile["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname"]),
  };
}
