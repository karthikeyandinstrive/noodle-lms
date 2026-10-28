import type { Capability } from "@lms/rbac";

export const capabilities = ["site:view_system"] as const satisfies readonly Capability[];
