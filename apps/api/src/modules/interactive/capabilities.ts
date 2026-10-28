import type { Capability } from "@lms/rbac";

export const capabilities = ["interactive:view", "interactive:view_results"] as const satisfies readonly Capability[];
