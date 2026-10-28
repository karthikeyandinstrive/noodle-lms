import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  inet,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { createdAt, id, orgId, ts, updatedAt } from "./_common";

// ─── Tenancy ────────────────────────────────────────────────────────────────

export const organizations = pgTable("organizations", {
  id: id(),
  name: text().notNull(),
  slug: text().notNull().unique(),
  customDomain: text().unique(),
  plan: text().notNull().default("free"),
  status: text().notNull().default("active"),
  settings: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ─── Users & auth ───────────────────────────────────────────────────────────

export const userStatus = pgEnum("user_status", ["active", "suspended", "pending"]);

export const users = pgTable(
  "users",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    email: text().notNull(),
    passwordHash: text(),
    firstName: text().notNull(),
    lastName: text().notNull(),
    avatarFileId: uuid(),
    bio: text(),
    locale: text().notNull().default("en"),
    timezone: text().notNull().default("UTC"),
    status: userStatus().notNull().default("active"),
    emailVerifiedAt: ts(),
    lastLoginAt: ts(),
    failedLoginCount: integer().notNull().default(0),
    lockedUntil: ts(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts(),
  },
  (t) => [uniqueIndex("users_org_email_uq").on(t.organizationId, sql`lower(${t.email})`)],
);

/** Server-side sessions. Only a SHA-256 hash of the opaque token is stored. */
export const sessions = pgTable(
  "sessions",
  {
    id: text().primaryKey(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: ts().notNull(),
    lastSeenAt: ts().notNull().defaultNow(),
    ip: inet(),
    userAgent: text(),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const authTokenPurpose = pgEnum("auth_token_purpose", ["password_reset", "email_verify", "invite"]);

export const authTokens = pgTable("auth_tokens", {
  id: id(),
  organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
  userId: uuid()
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  purpose: authTokenPurpose().notNull(),
  tokenHash: text().notNull().unique(),
  expiresAt: ts().notNull(),
  usedAt: ts(),
  createdAt: createdAt(),
});

// ─── RBAC (Moodle-style contexts) ───────────────────────────────────────────

export const contextLevel = pgEnum("context_level", ["system", "category", "course", "activity", "user"]);

/**
 * Permission contexts form a tree: system → category → course → activity.
 * `path` is a materialized path of ancestor ids ("/a/b/c") for fast inheritance lookups.
 */
export const contexts = pgTable(
  "contexts",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    level: contextLevel().notNull(),
    instanceId: uuid(),
    parentId: uuid().references((): AnyPgColumn => contexts.id, { onDelete: "cascade" }),
    path: text().notNull(),
    depth: integer().notNull(),
  },
  (t) => [
    uniqueIndex("contexts_level_instance_uq").on(t.organizationId, t.level, t.instanceId),
    index("contexts_path_idx").on(t.path),
  ],
);

export const permission = pgEnum("permission", ["allow", "prevent", "prohibit"]);

export const roles = pgTable(
  "roles",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    shortname: text().notNull(),
    name: text().notNull(),
    description: text(),
    archetype: text().notNull(),
    sortOrder: integer().notNull().default(0),
    assignableLevels: text().array().notNull().default(sql`'{}'::text[]`),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("roles_org_shortname_uq").on(t.organizationId, t.shortname)],
);

/** Role defaults, applied at the system context. */
export const roleCapabilities = pgTable(
  "role_capabilities",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    roleId: uuid()
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    capability: text().notNull(),
    permission: permission().notNull(),
  },
  (t) => [uniqueIndex("role_caps_uq").on(t.roleId, t.capability)],
);

/** Per-context overrides of a role's capability (Moodle "permission overrides"). */
export const roleOverrides = pgTable(
  "role_overrides",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    roleId: uuid()
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    contextId: uuid()
      .notNull()
      .references(() => contexts.id, { onDelete: "cascade" }),
    capability: text().notNull(),
    permission: permission().notNull(),
  },
  (t) => [uniqueIndex("role_overrides_uq").on(t.roleId, t.contextId, t.capability)],
);

export const roleAssignments = pgTable(
  "role_assignments",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleId: uuid()
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    contextId: uuid()
      .notNull()
      .references(() => contexts.id, { onDelete: "cascade" }),
    assignedBy: uuid(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("role_assignments_uq").on(t.userId, t.roleId, t.contextId),
    index("role_assignments_ctx_idx").on(t.contextId),
  ],
);

// ─── Cohorts (site-wide user groups) ────────────────────────────────────────

export const cohorts = pgTable("cohorts", {
  id: id(),
  organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
  name: text().notNull(),
  idnumber: text(),
  description: text(),
  createdAt: createdAt(),
});

export const cohortMembers = pgTable(
  "cohort_members",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    cohortId: uuid()
      .notNull()
      .references(() => cohorts.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("cohort_members_uq").on(t.cohortId, t.userId)],
);

// ─── Storage & files ────────────────────────────────────────────────────────

export const storageProvider = pgEnum("storage_provider", ["local", "s3", "minio", "r2"]);

export const storageConfigs = pgTable(
  "storage_configs",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    provider: storageProvider().notNull(),
    enabled: boolean().notNull().default(false),
    endpoint: text(),
    region: text(),
    bucket: text().notNull(),
    accessKeyId: text().notNull(),
    /** AES-256-GCM ciphertext (see apps/api core/crypto). Never returned by the API. */
    secretAccessKeyEnc: text().notNull(),
    publicUrl: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("storage_configs_org_uq").on(t.organizationId)],
);

export const files = pgTable(
  "files",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    ownerId: uuid().references(() => users.id, { onDelete: "set null" }),
    contextId: uuid().references(() => contexts.id, { onDelete: "cascade" }),
    /** e.g. "assignment", "course", "certificate", "user" */
    component: text().notNull(),
    /** e.g. "submission", "overview_image", "issued", "avatar" */
    area: text().notNull(),
    itemId: uuid(),
    storageKey: text().notNull().unique(),
    storageProvider: storageProvider().notNull(),
    filename: text().notNull(),
    mimeType: text().notNull(),
    size: bigint({ mode: "number" }).notNull(),
    sha256: text(),
    status: text().notNull().default("pending"),
    createdAt: createdAt(),
    deletedAt: ts(),
  },
  (t) => [index("files_item_idx").on(t.component, t.area, t.itemId)],
);

// ─── Auditing, analytics log, notifications, calendar ───────────────────────

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    actorId: uuid(),
    action: text().notNull(),
    targetType: text(),
    targetId: text(),
    metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    ip: inet(),
    userAgent: text(),
    createdAt: createdAt(),
  },
  (t) => [index("audit_logs_org_created_idx").on(t.organizationId, t.createdAt)],
);

/** Learner-facing event log, the data source for reports (Moodle "standard log"). */
export const eventLog = pgTable(
  "event_log",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    eventName: text().notNull(),
    userId: uuid(),
    courseId: uuid(),
    activityId: uuid(),
    relatedUserId: uuid(),
    data: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index("event_log_course_idx").on(t.courseId, t.createdAt),
    index("event_log_user_idx").on(t.userId, t.createdAt),
  ],
);

export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text().notNull(),
    title: text().notNull(),
    body: text(),
    link: text(),
    readAt: ts(),
    emailedAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [index("notifications_user_idx").on(t.userId, t.createdAt)],
);

export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text().notNull(),
    inApp: boolean().notNull().default(true),
    email: boolean().notNull().default(true),
  },
  (t) => [uniqueIndex("notification_prefs_uq").on(t.userId, t.type)],
);

export const calendarEventType = pgEnum("calendar_event_type", ["site", "course", "user", "due", "session"]);

export const calendarEvents = pgTable(
  "calendar_events",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    type: calendarEventType().notNull(),
    courseId: uuid(),
    userId: uuid(),
    activityId: uuid(),
    name: text().notNull(),
    description: text(),
    startsAt: ts().notNull(),
    durationMinutes: integer().notNull().default(0),
    createdBy: uuid(),
    createdAt: createdAt(),
  },
  (t) => [index("calendar_events_start_idx").on(t.organizationId, t.startsAt)],
);
