import type { Capability } from "@lms/rbac";

export const capabilities = ["workshop:submit", "workshop:peer_assess", "workshop:manage"] as const satisfies readonly Capability[];
