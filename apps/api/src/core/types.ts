import type { DB } from "@lms/db";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { Capability } from "@lms/rbac";

export type Org = { id: string; slug: string; name: string; plan: string; settings: Record<string, unknown> };

export type SessionUser = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  locale: string;
  timezone: string;
};

declare module "fastify" {
  interface FastifyRequest {
    /** Organization resolved from the Host header. Absent only on `config.tenant === false` routes. */
    org: Org;
    user: SessionUser | null;
    sessionId: string | null;
    authVia: "cookie" | "bearer" | null;
    /** Runs `fn` in a transaction scoped (RLS) to the request's organization. */
    tenant<T>(fn: (tx: DB) => Promise<T>): Promise<T>;
    /** Per-request memo for permission checks. */
    capabilityCache: Map<string, boolean>;
  }
  interface FastifyContextConfig {
    /** false = route does not need an organization (health, docs, webhooks, org signup). */
    tenant?: boolean;
  }
}

/** A feature module — the TypeScript equivalent of a Moodle plugin. */
export type LmsModule = {
  name: string;
  /** Mounted under /api/v1 + basePath. */
  basePath: string;
  routes: FastifyPluginAsyncZod;
  /** Capabilities the module defines (documentation + validation that they exist in @lms/rbac). */
  capabilities?: readonly Capability[];
  /** Called once at startup: register event subscribers, activity types, file access rules. */
  setup?: () => void | Promise<void>;
};
