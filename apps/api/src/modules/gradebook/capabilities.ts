import type { Capability } from "@lms/rbac";

export const capabilities = ["grades:view_own", "grades:view_all", "grades:edit", "grades:export"] as const satisfies readonly Capability[];
