import type { Archetype, Capability, Permission } from "./capabilities";

export type RoleGrant = {
  roleId: string;
  archetype: Archetype;
  /** Depth of the context the role was assigned in (system = 0). */
  assignedDepth: number;
};

export type PermissionEntry = {
  roleId: string;
  capability: string;
  permission: Permission;
  /** Depth of the context where this entry applies; role defaults use -1. */
  depth: number;
};

/**
 * Moodle-style permission resolution for one capability in one context.
 *
 * Inputs are all role assignments the user holds in the target context or any
 * ancestor, plus every permission entry (role defaults + overrides) on that
 * context path.
 *
 * Rules:
 *  1. super_admin always passes.
 *  2. A `prohibit` for any held role anywhere on the path denies outright.
 *  3. For each role, the entry at the deepest context wins (overrides beat defaults).
 *  4. Access is granted if at least one role resolves to `allow`.
 */
export function resolveCapability(
  capability: Capability,
  grants: RoleGrant[],
  entries: PermissionEntry[],
): boolean {
  if (grants.some((g) => g.archetype === "super_admin")) return true;
  if (grants.length === 0) return false;

  const heldRoles = new Set(grants.map((g) => g.roleId));
  const relevant = entries.filter((e) => e.capability === capability && heldRoles.has(e.roleId));

  if (relevant.some((e) => e.permission === "prohibit")) return false;

  const winner = new Map<string, PermissionEntry>();
  for (const e of relevant) {
    const current = winner.get(e.roleId);
    if (!current || e.depth > current.depth) winner.set(e.roleId, e);
  }
  for (const e of winner.values()) {
    if (e.permission === "allow") return true;
  }
  return false;
}
