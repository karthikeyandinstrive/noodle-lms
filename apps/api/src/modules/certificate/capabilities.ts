import type { Capability } from "@lms/rbac";

export const capabilities = ["certificate:manage_templates", "certificate:issue", "certificate:view_issued"] as const satisfies readonly Capability[];
