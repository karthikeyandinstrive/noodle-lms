import { hash } from "@node-rs/argon2";
import { ARCHETYPES, defaultCapabilities } from "@lms/rbac";
import type { DB } from "./client";
import { createContext } from "./helpers";
import { organizations, roleAssignments, roleCapabilities, roles, users } from "./schema";

/** OWASP-recommended argon2id parameters. */
export const ARGON2_OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string) {
  return hash(password, ARGON2_OPTIONS);
}

/**
 * Creates an organization with its system context, the default roles
 * (seeded with default capabilities) and an initial admin.
 * Must run on an unscoped (system) connection, inside a transaction.
 */
export async function bootstrapOrganization(
  tx: DB,
  input: {
    name: string;
    slug: string;
    admin: { email: string; password: string; firstName: string; lastName: string };
    adminArchetype?: "org_admin" | "super_admin";
  },
) {
  const [org] = await tx.insert(organizations).values({ name: input.name, slug: input.slug }).returning();
  const organizationId = org!.id;
  const systemContext = await createContext(tx, { organizationId, level: "system", instanceId: null, parentId: null });

  const roleIds = new Map<string, string>();
  for (const [i, a] of ARCHETYPES.entries()) {
    const [role] = await tx
      .insert(roles)
      .values({
        organizationId,
        shortname: a.archetype,
        name: a.name,
        description: a.description,
        archetype: a.archetype,
        sortOrder: i,
        assignableLevels: a.levels,
      })
      .returning();
    roleIds.set(a.archetype, role!.id);
    const caps = defaultCapabilities(a.archetype);
    if (caps.length) {
      await tx
        .insert(roleCapabilities)
        .values(caps.map((capability) => ({ organizationId, roleId: role!.id, capability, permission: "allow" as const })));
    }
  }

  const [admin] = await tx
    .insert(users)
    .values({
      organizationId,
      email: input.admin.email.toLowerCase(),
      passwordHash: await hashPassword(input.admin.password),
      firstName: input.admin.firstName,
      lastName: input.admin.lastName,
      emailVerifiedAt: new Date(),
    })
    .returning();

  await tx.insert(roleAssignments).values({
    organizationId,
    userId: admin!.id,
    roleId: roleIds.get(input.adminArchetype ?? "org_admin")!,
    contextId: systemContext.id,
  });

  return { organization: org!, systemContext, admin: admin!, roleIds };
}
