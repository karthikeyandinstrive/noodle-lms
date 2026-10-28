import type { Capability } from "@lms/rbac";

export const capabilities = ["question:manage"] as const satisfies readonly Capability[];
