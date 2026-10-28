import { and, eq, inArray } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { contexts, roleAssignments, roleCapabilities, roleOverrides, roles, type DB } from "@lms/db";
import { resolveCapability, type Archetype, type Capability, type PermissionEntry } from "@lms/rbac";
import { forbidden, notFound } from "./errors";

type ContextLevel = (typeof contexts.$inferSelect)["level"];

/** Ancestor context ids (root first) including the context itself. */
async function contextPath(tx: DB, contextId: string) {
  const [ctx] = await tx.select({ path: contexts.path }).from(contexts).where(eq(contexts.id, contextId)).limit(1);
  if (!ctx) throw notFound("Context");
  return ctx.path.split("/").filter(Boolean);
}

/**
 * Checks one capability for a user in a context (Moodle `has_capability`).
 * Pass the request's transaction — never open a new one from inside a transaction.
 */
export async function hasCapability(
  tx: DB,
  req: Pick<FastifyRequest, "user" | "capabilityCache">,
  capability: Capability,
  contextId: string,
): Promise<boolean> {
  const user = req.user;
  if (!user) return false;
  const key = `${capability}@${contextId}`;
  const cached = req.capabilityCache?.get(key);
  if (cached !== undefined) return cached;

  const path = await contextPath(tx, contextId);
  const depthOf = new Map(path.map((id, i) => [id, i]));

  const grants = await tx
    .select({ roleId: roleAssignments.roleId, archetype: roles.archetype, contextId: roleAssignments.contextId })
    .from(roleAssignments)
    .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
    .where(and(eq(roleAssignments.userId, user.id), inArray(roleAssignments.contextId, path)));

  let allowed = false;
  if (grants.length) {
    const roleIds = [...new Set(grants.map((g) => g.roleId))];
    const [defaults, overrides] = await Promise.all([
      tx
        .select()
        .from(roleCapabilities)
        .where(and(inArray(roleCapabilities.roleId, roleIds), eq(roleCapabilities.capability, capability))),
      tx
        .select()
        .from(roleOverrides)
        .where(
          and(
            inArray(roleOverrides.roleId, roleIds),
            inArray(roleOverrides.contextId, path),
            eq(roleOverrides.capability, capability),
          ),
        ),
    ]);
    const entries: PermissionEntry[] = [
      ...defaults.map((d) => ({ roleId: d.roleId, capability: d.capability, permission: d.permission, depth: -1 })),
      ...overrides.map((o) => ({
        roleId: o.roleId,
        capability: o.capability,
        permission: o.permission,
        depth: depthOf.get(o.contextId) ?? 0,
      })),
    ];
    allowed = resolveCapability(
      capability,
      grants.map((g) => ({ roleId: g.roleId, archetype: g.archetype as Archetype, assignedDepth: depthOf.get(g.contextId) ?? 0 })),
      entries,
    );
  }
  req.capabilityCache?.set(key, allowed);
  return allowed;
}

/** Throws 403 unless the user has the capability (401 if signed out). */
export async function requireCapability(
  tx: DB,
  req: Pick<FastifyRequest, "user" | "capabilityCache">,
  capability: Capability,
  contextId: string,
) {
  if (!(await hasCapability(tx, req, capability, contextId))) throw forbidden(`Missing capability ${capability}`);
}

/** Evaluates several capabilities at once — used by the UI to decide what to show. */
export async function capabilityMap(
  tx: DB,
  req: Pick<FastifyRequest, "user" | "capabilityCache">,
  capabilities: Capability[],
  contextId: string,
) {
  const out: Partial<Record<Capability, boolean>> = {};
  for (const c of capabilities) out[c] = await hasCapability(tx, req, c, contextId);
  return out;
}

export async function findContext(tx: DB, level: ContextLevel, instanceId: string) {
  const [ctx] = await tx
    .select()
    .from(contexts)
    .where(and(eq(contexts.level, level), eq(contexts.instanceId, instanceId)))
    .limit(1);
  if (!ctx) throw notFound("Context");
  return ctx;
}

/** Assigns a role (by archetype shortname) in a context; idempotent. */
export async function assignRole(
  tx: DB,
  input: { organizationId: string; userId: string; shortname: string; contextId: string; assignedBy?: string | null },
) {
  const [role] = await tx.select().from(roles).where(eq(roles.shortname, input.shortname)).limit(1);
  if (!role) throw notFound(`Role ${input.shortname}`);
  await tx
    .insert(roleAssignments)
    .values({
      organizationId: input.organizationId,
      userId: input.userId,
      roleId: role.id,
      contextId: input.contextId,
      assignedBy: input.assignedBy ?? null,
    })
    .onConflictDoNothing();
  return role;
}

export async function unassignRoles(tx: DB, userId: string, contextId: string) {
  await tx.delete(roleAssignments).where(and(eq(roleAssignments.userId, userId), eq(roleAssignments.contextId, contextId)));
}
