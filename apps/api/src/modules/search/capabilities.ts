import type { Capability } from "@lms/rbac";

export const capabilities = ["course:view", "forum:view", "user:view"] as const satisfies readonly Capability[];
