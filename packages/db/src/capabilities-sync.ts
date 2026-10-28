import { and, eq } from "drizzle-orm";
import { CAPABILITY_NAMES, defaultCapabilities, type Archetype } from "@lms/rbac";
import type { DB } from "./client";
import { organizations, roleCapabilities, roles } from "./schema";

const KNOWN_KEY = "_knownCapabilities";

/**
 * Grants capabilities added in a new release to each organization's roles,
 * according to their archetype defaults. Capabilities an organization already
 * knew about are left alone, so an admin's deliberate removal is preserved.
 * Runs after migrations (system connection, bypasses RLS).
 */
export async function syncDefaultCapabilities(db: DB) {
  const orgs = await db.select().from(organizations);
  let granted = 0;
  for (const org of orgs) {
    const settings = org.settings as Record<string, unknown>;
    let known = new Set(Array.isArray(settings[KNOWN_KEY]) ? (settings[KNOWN_KEY] as string[]) : []);
    if (known.size === 0) {
      // Organization created before this tracking existed: what its roles already use is "known".
      const used = await db.selectDistinct({ c: roleCapabilities.capability }).from(roleCapabilities).where(eq(roleCapabilities.organizationId, org.id));
      known = new Set(used.map((u) => u.c));
    }
    const newCaps = CAPABILITY_NAMES.filter((c) => !known.has(c));

    if (newCaps.length) {
      const orgRoles = await db.select().from(roles).where(eq(roles.organizationId, org.id));
      for (const role of orgRoles) {
        const defaults = new Set<string>(defaultCapabilities(role.archetype as Archetype));
        for (const capability of newCaps) {
          if (!defaults.has(capability)) continue;
          const [exists] = await db
            .select({ id: roleCapabilities.id })
            .from(roleCapabilities)
            .where(and(eq(roleCapabilities.roleId, role.id), eq(roleCapabilities.capability, capability)))
            .limit(1);
          if (exists) continue;
          await db.insert(roleCapabilities).values({ organizationId: org.id, roleId: role.id, capability, permission: "allow" });
          granted++;
        }
      }
    }
    if (newCaps.length || !Array.isArray(settings[KNOWN_KEY])) {
      await db
        .update(organizations)
        .set({ settings: { ...settings, [KNOWN_KEY]: CAPABILITY_NAMES } })
        .where(eq(organizations.id, org.id));
    }
  }
  return granted;
}
