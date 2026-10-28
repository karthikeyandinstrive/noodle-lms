import type { Capability } from "@lms/rbac";

export const capabilities = ["billing:manage"] as const satisfies readonly Capability[];
