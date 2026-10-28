import { and, asc, eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { CAPABILITIES, CAPABILITY_NAMES, isCapability, type Capability } from "@lms/rbac";
import { contexts, getSystemContext, roleAssignments, roleCapabilities, roleOverrides, roles, users, type DB } from "@lms/db";
import { z } from "zod";
import { requireUser } from "../../core/auth";
import { audit } from "../../core/audit";
import { badRequest, forbidden, must } from "../../core/errors";
import { capabilityMap, requireCapability } from "../../core/rbac";
import { ok, zId, zOk } from "../../core/schemas";

const zPermission = z.enum(["allow", "prevent", "prohibit"]);
const zCapabilityName = z.string().refine(isCapability, "Unknown capability");

const zRole = z.object({
  id: zId,
  shortname: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  archetype: z.string(),
  assignableLevels: z.array(z.string()),
  capabilities: z.record(zPermission),
});

async function requireRoleManage(tx: DB, req: Parameters<typeof requireCapability>[1] & { org: { id: string } }) {
  const system = await getSystemContext(tx, req.org.id);
  await requireCapability(tx, req, "role:manage", system.id);
  return system;
}

async function roleWithCaps(tx: DB, role: typeof roles.$inferSelect) {
  const caps = await tx.select().from(roleCapabilities).where(eq(roleCapabilities.roleId, role.id));
  return { ...role, capabilities: Object.fromEntries(caps.map((c) => [c.capability, c.permission])) };
}

/** Assigning at system level needs role:manage; anywhere below needs role:assign in that context. */
async function requireAssignIn(tx: DB, req: Parameters<typeof requireCapability>[1] & { org: { id: string } }, contextId: string) {
  const [ctx] = await tx.select().from(contexts).where(eq(contexts.id, contextId)).limit(1);
  must(ctx, "Context");
  await requireCapability(tx, req, ctx!.level === "system" ? "role:manage" : "role:assign", contextId);
  return ctx!;
}

export const routes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/capabilities",
    {
      schema: {
        tags: ["Roles"],
        summary: "Every capability with its description and risk flag",
        response: { 200: z.array(z.object({ name: z.string(), description: z.string(), level: z.string(), risky: z.boolean() })) },
      },
    },
    async () =>
      CAPABILITY_NAMES.map((name) => {
        const def = CAPABILITIES[name] as { description: string; level: string; risky?: boolean };
        return { name, description: def.description, level: def.level, risky: def.risky ?? false };
      }),
  );

  app.get(
    "/me/capabilities",
    {
      schema: {
        tags: ["Roles"],
        summary: "Evaluate capabilities for the current user in a context",
        querystring: z.object({ contextId: zId, capabilities: z.string().describe("comma separated") }),
        response: { 200: z.record(z.boolean()) },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        const caps = req.query.capabilities.split(",").map((c) => c.trim()).filter(isCapability) as Capability[];
        return (await capabilityMap(tx, req, caps, req.query.contextId)) as Record<string, boolean>;
      }),
  );

  app.get("/roles", { schema: { tags: ["Roles"], summary: "List roles with their default capabilities", response: { 200: z.array(zRole) } } }, (req) =>
    req.tenant(async (tx) => {
      requireUser(req);
      const rows = await tx.select().from(roles).orderBy(asc(roles.sortOrder));
      return Promise.all(rows.map((r) => roleWithCaps(tx, r)));
    }),
  );

  app.post(
    "/roles",
    {
      schema: {
        tags: ["Roles"],
        summary: "Create a custom role, copying capabilities from an existing role",
        body: z.object({
          shortname: z.string().regex(/^[a-z0-9_]{2,50}$/),
          name: z.string().trim().min(1).max(100),
          description: z.string().max(1000).nullable().optional(),
          copyFromRoleId: zId,
          assignableLevels: z.array(z.enum(["system", "category", "course", "activity"])).min(1),
        }),
        response: { 201: zRole },
      },
    },
    async (req, reply) => {
      const role = await req.tenant(async (tx) => {
        await requireRoleManage(tx, req);
        const source = must((await tx.select().from(roles).where(eq(roles.id, req.body.copyFromRoleId)).limit(1))[0], "Role");
        if (source.archetype === "super_admin") throw forbidden("Cannot copy the super admin role");
        const [created] = await tx
          .insert(roles)
          .values({
            organizationId: req.org.id,
            shortname: req.body.shortname,
            name: req.body.name,
            description: req.body.description ?? null,
            archetype: source.archetype,
            assignableLevels: req.body.assignableLevels,
            sortOrder: 100,
          })
          .returning();
        const caps = await tx.select().from(roleCapabilities).where(eq(roleCapabilities.roleId, source.id));
        if (caps.length) {
          await tx.insert(roleCapabilities).values(caps.map((c) => ({ organizationId: req.org.id, roleId: created!.id, capability: c.capability, permission: c.permission })));
        }
        await audit(tx, req, "role.created", { type: "role", id: created!.id }, { copyFrom: source.shortname });
        return roleWithCaps(tx, created!);
      });
      return reply.status(201).send(role);
    },
  );

  app.patch(
    "/roles/:id",
    {
      schema: {
        tags: ["Roles"],
        summary: "Edit a role and its default permissions (null removes the permission)",
        params: z.object({ id: zId }),
        body: z.object({
          name: z.string().trim().min(1).max(100).optional(),
          description: z.string().max(1000).nullable().optional(),
          capabilities: z.record(zCapabilityName, zPermission.nullable()).optional(),
        }),
        response: { 200: zRole },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        await requireRoleManage(tx, req);
        const role = must((await tx.select().from(roles).where(eq(roles.id, req.params.id)).limit(1))[0], "Role");
        if (role.archetype === "super_admin") throw forbidden("The super admin role cannot be edited");
        const { capabilities, ...rest } = req.body;
        if (Object.keys(rest).length) await tx.update(roles).set(rest).where(eq(roles.id, role.id));
        for (const [capability, permission] of Object.entries(capabilities ?? {})) {
          await tx.delete(roleCapabilities).where(and(eq(roleCapabilities.roleId, role.id), eq(roleCapabilities.capability, capability)));
          if (permission) await tx.insert(roleCapabilities).values({ organizationId: req.org.id, roleId: role.id, capability, permission });
        }
        await audit(tx, req, "role.updated", { type: "role", id: role.id }, { capabilities });
        const [fresh] = await tx.select().from(roles).where(eq(roles.id, role.id));
        return roleWithCaps(tx, fresh!);
      }),
  );

  app.delete("/roles/:id", { schema: { tags: ["Roles"], summary: "Delete a custom role", params: z.object({ id: zId }), response: { 200: zOk } } }, async (req) => {
    await req.tenant(async (tx) => {
      await requireRoleManage(tx, req);
      const role = must((await tx.select().from(roles).where(eq(roles.id, req.params.id)).limit(1))[0], "Role");
      if (role.shortname === role.archetype) throw badRequest("Built-in roles cannot be deleted");
      await tx.delete(roles).where(eq(roles.id, role.id));
      await audit(tx, req, "role.deleted", { type: "role", id: role.id }, { shortname: role.shortname });
    });
    return ok;
  });

  // ─── Context overrides ──────────────────────────────────────────────────

  app.get(
    "/contexts/:contextId/overrides",
    {
      schema: {
        tags: ["Roles"],
        summary: "Permission overrides defined in a context",
        params: z.object({ contextId: zId }),
        response: { 200: z.array(z.object({ id: zId, roleId: zId, capability: z.string(), permission: zPermission })) },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        await requireCapability(tx, req, "role:assign", req.params.contextId);
        return tx.select().from(roleOverrides).where(eq(roleOverrides.contextId, req.params.contextId));
      }),
  );

  app.put(
    "/contexts/:contextId/overrides",
    {
      schema: {
        tags: ["Roles"],
        summary: "Set (or clear with null) a role's permission for a capability in this context",
        params: z.object({ contextId: zId }),
        body: z.object({ roleId: zId, capability: zCapabilityName, permission: zPermission.nullable() }),
        response: { 200: zOk },
      },
    },
    async (req) => {
      await req.tenant(async (tx) => {
        const ctx = await requireAssignIn(tx, req, req.params.contextId);
        // Prohibit is a site-level safety switch; only role managers may set it.
        if (req.body.permission === "prohibit") await requireRoleManage(tx, req);
        await tx
          .delete(roleOverrides)
          .where(and(eq(roleOverrides.contextId, ctx.id), eq(roleOverrides.roleId, req.body.roleId), eq(roleOverrides.capability, req.body.capability)));
        if (req.body.permission) {
          await tx.insert(roleOverrides).values({ organizationId: req.org.id, roleId: req.body.roleId, contextId: ctx.id, capability: req.body.capability, permission: req.body.permission });
        }
        await audit(tx, req, "role.override", { type: "context", id: ctx.id }, req.body);
      });
      return ok;
    },
  );

  // ─── Role assignments ───────────────────────────────────────────────────

  app.get(
    "/contexts/:contextId/role-assignments",
    {
      schema: {
        tags: ["Roles"],
        summary: "Users holding roles directly in a context",
        params: z.object({ contextId: zId }),
        response: {
          200: z.array(z.object({ id: zId, roleId: zId, roleName: z.string(), user: z.object({ id: zId, firstName: z.string(), lastName: z.string(), email: z.string() }) })),
        },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        await requireAssignIn(tx, req, req.params.contextId);
        const rows = await tx
          .select({ id: roleAssignments.id, roleId: roles.id, roleName: roles.name, u: users })
          .from(roleAssignments)
          .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
          .innerJoin(users, eq(users.id, roleAssignments.userId))
          .where(eq(roleAssignments.contextId, req.params.contextId));
        return rows.map((r) => ({ id: r.id, roleId: r.roleId, roleName: r.roleName, user: { id: r.u.id, firstName: r.u.firstName, lastName: r.u.lastName, email: r.u.email } }));
      }),
  );

  app.post(
    "/role-assignments",
    {
      schema: {
        tags: ["Roles"],
        summary: "Assign a role to a user in a context",
        body: z.object({ userId: zId, roleId: zId, contextId: zId }),
        response: { 200: zOk },
      },
    },
    async (req) => {
      await req.tenant(async (tx) => {
        const ctx = await requireAssignIn(tx, req, req.body.contextId);
        const role = must((await tx.select().from(roles).where(eq(roles.id, req.body.roleId)).limit(1))[0], "Role");
        if (!role.assignableLevels.includes(ctx.level)) throw badRequest(`${role.name} cannot be assigned at ${ctx.level} level`);
        if (role.archetype === "super_admin" || role.archetype === "org_admin") await requireRoleManage(tx, req);
        await tx
          .insert(roleAssignments)
          .values({ organizationId: req.org.id, userId: req.body.userId, roleId: role.id, contextId: ctx.id, assignedBy: req.user!.id })
          .onConflictDoNothing();
        await audit(tx, req, "role.assigned", { type: "user", id: req.body.userId }, { role: role.shortname, contextId: ctx.id });
      });
      return ok;
    },
  );

  app.delete(
    "/role-assignments/:id",
    { schema: { tags: ["Roles"], summary: "Remove a role assignment", params: z.object({ id: zId }), response: { 200: zOk } } },
    async (req) => {
      await req.tenant(async (tx) => {
        const ra = must((await tx.select().from(roleAssignments).where(eq(roleAssignments.id, req.params.id)).limit(1))[0], "Role assignment");
        await requireAssignIn(tx, req, ra.contextId);
        if (ra.userId === req.user?.id) {
          const [role] = await tx.select().from(roles).where(eq(roles.id, ra.roleId));
          if (role?.archetype === "org_admin") throw badRequest("You cannot remove your own admin role");
        }
        await tx.delete(roleAssignments).where(eq(roleAssignments.id, ra.id));
        await audit(tx, req, "role.unassigned", { type: "user", id: ra.userId }, { roleId: ra.roleId, contextId: ra.contextId });
      });
      return ok;
    },
  );
};
