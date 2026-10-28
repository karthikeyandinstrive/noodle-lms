import type { Capability } from "@lms/rbac";

export const capabilities = ["notification:send"] as const satisfies readonly Capability[];
