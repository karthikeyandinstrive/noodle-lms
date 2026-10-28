import type { Capability } from "@lms/rbac";

export const capabilities = ["payment:manage"] as const satisfies readonly Capability[];
