import { and, eq, sql } from "drizzle-orm";
import { ssoProviders, userIdentities, users, type DB, type OidcConfig, type SamlConfig } from "@lms/db";
import { hmac, safeEqual } from "../../core/crypto";
import { AppError } from "../../core/errors";
import { emitInTx } from "../../core/events";
import { assertWithinLimits } from "../billing/service";

export type SsoProvider = typeof ssoProviders.$inferSelect;

/**
 * Error codes surfaced to the login page as /login?error=<code>. IdP messages
 * are never echoed; the details only go to the server log.
 */
export const SSO_ERROR_CODES = [
  "sso_failed",
  "sso_unavailable",
  "sso_state",
  "sso_email_missing",
  "sso_email_unverified",
  "sso_domain_not_allowed",
  "sso_no_account",
  "sso_account_inactive",
  "sso_plan_limit",
] as const;
export type SsoErrorCode = (typeof SSO_ERROR_CODES)[number];

export class SsoError extends Error {
  constructor(
    public readonly code: SsoErrorCode,
    detail?: string,
  ) {
    super(detail ?? code);
  }
}

// ─── Redirect target sanitizer ──────────────────────────────────────────────

export const DEFAULT_NEXT = "/dashboard";

/**
 * Accepts only same-site relative paths ("/courses/1?x#y"). Rejects absolute
 * URLs, protocol-relative ("//evil"), backslash tricks ("/\\evil"), control
 * characters and anything that resolves to another origin.
 */
export function sanitizeNext(next: unknown): string {
  if (typeof next !== "string" || next.length === 0 || next.length > 1000) return DEFAULT_NEXT;
  if (!next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return DEFAULT_NEXT;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(next)) return DEFAULT_NEXT;
  try {
    const base = "http://same-site.invalid";
    const url = new URL(next, base);
    if (url.origin !== base) return DEFAULT_NEXT;
    const out = `${url.pathname}${url.search}${url.hash}`;
    return out.startsWith("//") ? DEFAULT_NEXT : out;
  } catch {
    return DEFAULT_NEXT;
  }
}

// ─── Signed, expiring values (state cookie, SAML RelayState) ────────────────

export function signValue(payload: Record<string, unknown>, ttlSeconds: number) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString("base64url");
  return `${body}.${hmac(`sso:${body}`)}`;
}

export function verifySignedValue<T extends Record<string, unknown>>(value: string | undefined | null): T | null {
  if (!value) return null;
  const [body, sig] = value.split(".");
  if (!body || !sig || !safeEqual(sig, hmac(`sso:${body}`))) return null;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T & { exp?: number };
    if (typeof data.exp !== "number" || data.exp < Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch {
    return null;
  }
}

// ─── Providers ──────────────────────────────────────────────────────────────

export const isOidc = (p: SsoProvider): p is SsoProvider & { config: OidcConfig } => p.type === "oidc";
export const isSaml = (p: SsoProvider): p is SsoProvider & { config: SamlConfig } => p.type === "saml";

/** True when an enabled provider is marked enforced: password sign-in is then for admins only. */
export async function isSsoEnforced(tx: DB) {
  const [row] = await tx
    .select({ id: ssoProviders.id })
    .from(ssoProviders)
    .where(and(eq(ssoProviders.enabled, true), eq(ssoProviders.enforced, true)))
    .limit(1);
  return !!row;
}

export const emailDomain = (email: string) => email.split("@").pop()!.toLowerCase();

export function domainAllowed(provider: Pick<SsoProvider, "allowedDomains">, email: string) {
  if (!provider.allowedDomains.length) return true;
  return provider.allowedDomains.map((d) => d.toLowerCase()).includes(emailDomain(email));
}

/** Domain explicitly listed (not just "any domain"): used when the IdP doesn't say whether the email is verified. */
export function domainExplicitlyAllowed(provider: Pick<SsoProvider, "allowedDomains">, email: string) {
  return provider.allowedDomains.length > 0 && domainAllowed(provider, email);
}

// ─── Account resolution ─────────────────────────────────────────────────────

export type ExternalIdentity = {
  subject: string;
  email: string | null | undefined;
  /** true / false as asserted by the IdP; undefined when the IdP didn't say. */
  emailVerified?: boolean | undefined;
  firstName?: string | null | undefined;
  lastName?: string | null | undefined;
};

export type ResolvedAccount = { userId: string; email: string; linked: boolean; provisioned: boolean };

/**
 * Maps an external identity to a local user:
 *  1. an existing (provider, subject) link;
 *  2. else an existing user with the same email (case-insensitive) — linked, only if the domain is allowed;
 *  3. else, when autoProvision is on and the plan allows it, a new active user without a password.
 * Suspended or deleted users are rejected. The email must be verified (OIDC: `email_verified`, or,
 * when the IdP doesn't send it, an explicitly allowed domain; SAML assertions are signed by the IdP).
 */
export async function resolveAccount(
  tx: DB,
  organizationId: string,
  provider: Pick<SsoProvider, "id" | "allowedDomains" | "autoProvision">,
  identity: ExternalIdentity,
): Promise<ResolvedAccount> {
  if (!identity.subject) throw new SsoError("sso_failed", "missing subject");
  const email = identity.email?.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+$/.test(email)) throw new SsoError("sso_email_missing");
  if (identity.emailVerified === false) throw new SsoError("sso_email_unverified");
  if (identity.emailVerified === undefined && !domainExplicitlyAllowed(provider, email)) throw new SsoError("sso_email_unverified");
  if (!domainAllowed(provider, email)) throw new SsoError("sso_domain_not_allowed");

  const now = new Date();
  const assertActive = (u: typeof users.$inferSelect | undefined) => {
    if (!u || u.deletedAt || u.status !== "active") throw new SsoError("sso_account_inactive");
    return u;
  };

  // 1. Existing link.
  const [linked] = await tx
    .select({ identity: userIdentities, user: users })
    .from(userIdentities)
    .innerJoin(users, eq(users.id, userIdentities.userId))
    .where(and(eq(userIdentities.providerId, provider.id), eq(userIdentities.subject, identity.subject)))
    .limit(1);
  if (linked) {
    const user = assertActive(linked.user);
    await tx.update(userIdentities).set({ email, lastLoginAt: now }).where(eq(userIdentities.id, linked.identity.id));
    await tx.update(users).set({ lastLoginAt: now }).where(eq(users.id, user.id));
    return { userId: user.id, email: user.email, linked: false, provisioned: false };
  }

  // 2. Same email (including deleted rows: the unique index covers them, so they must block provisioning too).
  const [existing] = await tx
    .select()
    .from(users)
    .where(eq(sql`lower(${users.email})`, email))
    .limit(1);
  if (existing) {
    const user = assertActive(existing);
    await tx.insert(userIdentities).values({ organizationId, userId: user.id, providerId: provider.id, subject: identity.subject, email, lastLoginAt: now });
    await tx.update(users).set({ lastLoginAt: now, emailVerifiedAt: user.emailVerifiedAt ?? now }).where(eq(users.id, user.id));
    return { userId: user.id, email: user.email, linked: true, provisioned: false };
  }

  // 3. Auto-provision.
  if (!provider.autoProvision) throw new SsoError("sso_no_account");
  try {
    await assertWithinLimits(tx, organizationId, "users");
  } catch (err) {
    if (err instanceof AppError && err.code === "PLAN_LIMIT") throw new SsoError("sso_plan_limit");
    throw err;
  }
  const local = email.split("@")[0]!;
  const [created] = await tx
    .insert(users)
    .values({
      organizationId,
      email,
      passwordHash: null,
      firstName: identity.firstName?.trim().slice(0, 100) || local.slice(0, 100),
      lastName: identity.lastName?.trim().slice(0, 100) || "",
      status: "active",
      emailVerifiedAt: now,
      lastLoginAt: now,
    })
    .returning();
  await tx.insert(userIdentities).values({ organizationId, userId: created!.id, providerId: provider.id, subject: identity.subject, email, lastLoginAt: now });
  await emitInTx(tx, "user.created", { organizationId, userId: created!.id });
  return { userId: created!.id, email, linked: true, provisioned: true };
}

/** Enabled provider by slug, or null. */
export async function findEnabledProvider(tx: DB, slug: string) {
  const [row] = await tx
    .select()
    .from(ssoProviders)
    .where(and(eq(ssoProviders.slug, slug), eq(ssoProviders.enabled, true)))
    .limit(1);
  return row ?? null;
}
