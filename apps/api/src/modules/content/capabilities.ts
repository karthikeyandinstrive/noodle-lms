import type { Capability } from "@lms/rbac";

export const capabilities = ["course:view"] as const satisfies readonly Capability[];
