import { boolean, index, integer, jsonb, numeric, pgEnum, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, orgId, ts, updatedAt } from "./_common";
import { files, organizations, users } from "./core";
import { activities, courses } from "./courses";

const grade = () => numeric({ precision: 10, scale: 5, mode: "number" });

// ─── LTI 1.3 (we are the platform / consumer) ───────────────────────────────

/** RSA key pair used to sign our LTI messages; public keys served at the JWKS URL. */
export const ltiKeys = pgTable("lti_keys", {
  id: id(),
  organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
  kid: text().notNull().unique(),
  publicJwk: jsonb().$type<Record<string, unknown>>().notNull(),
  /** PKCS8 PEM, AES-GCM encrypted. */
  privateKeyEnc: text().notNull(),
  active: boolean().notNull().default(true),
  createdAt: createdAt(),
});

/** A registered external tool (site-level), reusable by many activities. */
export const ltiTools = pgTable("lti_tools", {
  id: id(),
  organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
  name: text().notNull(),
  description: text(),
  /** client_id we issued to the tool. */
  clientId: text().notNull().unique(),
  deploymentId: text().notNull(),
  /** Tool's OIDC login initiation URL. */
  loginUrl: text().notNull(),
  /** Default target link URI (launch URL). */
  launchUrl: text().notNull(),
  /** Where Deep Linking requests go (content selection); the launch URL when empty. */
  deepLinkingUrl: text(),
  /** Tool's JWKS URL (for verifying its service-token assertions and deep linking responses). */
  jwksUrl: text().notNull(),
  /** Allowed redirect URIs. */
  redirectUris: text().array().notNull().default([]),
  /** Services enabled for the tool. */
  scopes: text().array().notNull().default([]),
  sharePersonalData: boolean().notNull().default(true),
  enabled: boolean().notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** External tool activity settings. */
export const ltiLinks = pgTable("lti_links", {
  id: id(),
  organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
  activityId: uuid()
    .notNull()
    .unique()
    .references(() => activities.id, { onDelete: "cascade" }),
  toolId: uuid()
    .notNull()
    .references(() => ltiTools.id),
  /** Overrides the tool's launch URL (from deep linking). */
  targetLinkUri: text(),
  customParams: jsonb().$type<Record<string, string>>().notNull().default({}),
  /** AGS line item: when set, the tool may post scores. */
  gradeMax: grade(),
  openInNewWindow: boolean().notNull().default(false),
});

/** Short-lived state between OIDC login initiation and the launch (nonce, target activity). */
export const ltiLaunches = pgTable(
  "lti_launches",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    activityId: uuid()
      .notNull()
      .references(() => activities.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Value passed as lti_message_hint, single use. */
    hint: text().notNull().unique(),
    /** LtiResourceLinkRequest, or LtiDeepLinkingRequest when a teacher picks content in the tool. */
    messageType: text().notNull().default("LtiResourceLinkRequest"),
    nonce: text(),
    expiresAt: ts().notNull(),
    usedAt: ts(),
    /** Deep Linking: when the tool's response was accepted (single use). */
    completedAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [index("lti_launches_expires_idx").on(t.expiresAt)],
);

// ─── SCORM ──────────────────────────────────────────────────────────────────

export const scormVersion = pgEnum("scorm_version", ["1.2", "2004"]);

export const scormPackages = pgTable("scorm_packages", {
  id: id(),
  organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
  activityId: uuid()
    .notNull()
    .unique()
    .references(() => activities.id, { onDelete: "cascade" }),
  packageFileId: uuid().references(() => files.id, { onDelete: "set null" }),
  version: scormVersion().notNull(),
  /** Launch file inside the package, e.g. "index_lms.html". */
  entryHref: text().notNull(),
  /** Storage prefix of the extracted package. */
  storagePrefix: text().notNull(),
  title: text(),
  manifest: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  gradeMax: grade().notNull().default(100),
  /** highest | average | first | last */
  gradeMethod: text().notNull().default("highest"),
  maxAttempts: integer().notNull().default(0),
  createdAt: createdAt(),
});

export const scormAttempts = pgTable(
  "scorm_attempts",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    packageId: uuid()
      .notNull()
      .references(() => scormPackages.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    attempt: integer().notNull(),
    /** Full CMI data model as key/value pairs, e.g. { "cmi.core.lesson_status": "completed" }. */
    cmi: jsonb().$type<Record<string, string>>().notNull().default({}),
    /** Normalized: not attempted | incomplete | completed | passed | failed | browsed */
    status: text().notNull().default("not attempted"),
    scoreRaw: numeric({ mode: "number" }),
    scoreMax: numeric({ mode: "number" }),
    totalTimeSeconds: integer().notNull().default(0),
    startedAt: ts().notNull().defaultNow(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("scorm_attempts_uq").on(t.packageId, t.userId, t.attempt)],
);

/**
 * Per-SCO tracking for packages with several SCOs. The attempt row then holds the
 * aggregate (status, score, time) across them; single-SCO packages keep the CMI on the attempt.
 */
export const scormScoTracks = pgTable(
  "scorm_sco_tracks",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    attemptId: uuid()
      .notNull()
      .references(() => scormAttempts.id, { onDelete: "cascade" }),
    /** Manifest item identifier of the SCO. */
    scoId: text().notNull(),
    cmi: jsonb().$type<Record<string, string>>().notNull().default({}),
    status: text().notNull().default("not attempted"),
    scoreRaw: numeric({ mode: "number" }),
    scoreMax: numeric({ mode: "number" }),
    totalTimeSeconds: integer().notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("scorm_sco_tracks_uq").on(t.attemptId, t.scoId)],
);

// ─── Course backup / restore ────────────────────────────────────────────────

export const backupKind = pgEnum("backup_kind", ["backup", "restore"]);
export const backupStatus = pgEnum("backup_status", ["queued", "running", "done", "failed"]);

export const courseBackups = pgTable(
  "course_backups",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    kind: backupKind().notNull(),
    status: backupStatus().notNull().default("queued"),
    /** Source course (backup) or created course (restore). */
    courseId: uuid().references(() => courses.id, { onDelete: "set null" }),
    /** The archive (output of a backup, input of a restore). */
    fileId: uuid().references(() => files.id, { onDelete: "set null" }),
    /** What to include, e.g. { userData: false, files: true }. */
    options: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    /** Counts / warnings produced while running. */
    report: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    error: text(),
    createdBy: uuid(),
    createdAt: createdAt(),
    finishedAt: ts(),
  },
  (t) => [index("course_backups_course_idx").on(t.courseId)],
);
