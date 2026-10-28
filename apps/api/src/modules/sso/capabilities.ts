import type { Capability } from "@lms/rbac";

export const capabilities = ["site:manage_sso"] as const satisfies readonly Capability[];
