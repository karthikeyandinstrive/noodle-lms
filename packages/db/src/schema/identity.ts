import { boolean, index, jsonb, pgEnum, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, orgId, ts, updatedAt } from "./_common";
import { organizations, users } from "./core";

// ─── Single sign-on ─────────────────────────────────────────────────────────

export const ssoType = pgEnum("sso_type", ["oidc", "saml"]);

export type OidcConfig = {
  issuer: string;
  clientId: string;
  /** AES-GCM ciphertext (core/crypto). Never returned by the API. */
  clientSecretEnc: string;
  scopes?: string;
};
export type SamlConfig = {
  entryPoint: string;
  idpIssuer?: string;
  /** IdP signing certificate (PEM body). */
  idpCert: string;
  /** Our SP entity id; defaults to the metadata URL. */
  spEntityId?: string;
};

export const ssoProviders = pgTable(
  "sso_providers",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    type: ssoType().notNull(),
    /** URL-safe key used in login URLs, e.g. "google", "okta". */
    slug: text().notNull(),
    name: text().notNull(),
    enabled: boolean().notNull().default(false),
    config: jsonb().$type<OidcConfig | SamlConfig>().notNull(),
    /** Create a user on first login when no account matches. */
    autoProvision: boolean().notNull().default(false),
    /** Restrict to these email domains (empty = any). */
    allowedDomains: text().array().notNull().default([]),
    /** Hide the password form when SSO is mandatory. */
    enforced: boolean().notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("sso_providers_org_slug_uq").on(t.organizationId, t.slug)],
);

/** Links an external identity (provider + subject) to a local user. */
export const userIdentities = pgTable(
  "user_identities",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    providerId: uuid()
      .notNull()
      .references(() => ssoProviders.id, { onDelete: "cascade" }),
    subject: text().notNull(),
    email: text(),
    lastLoginAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("user_identities_provider_subject_uq").on(t.providerId, t.subject), index("user_identities_user_idx").on(t.userId)],
);

// ─── Multi-factor authentication ────────────────────────────────────────────

export const userMfa = pgTable("user_mfa", {
  id: id(),
  organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
  userId: uuid()
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  /** Base32 TOTP secret, AES-GCM encrypted. */
  totpSecretEnc: text().notNull(),
  /** Null until the user confirms a first code. */
  enabledAt: ts(),
  /** SHA-256 hashes of unused one-time recovery codes. */
  recoveryCodeHashes: text().array().notNull().default([]),
  /** Last accepted TOTP time-step, to block code replay. */
  lastUsedStep: text(),
  createdAt: createdAt(),
});
