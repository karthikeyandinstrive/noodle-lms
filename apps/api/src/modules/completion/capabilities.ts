import type { Capability } from "@lms/rbac";

export const capabilities = ["completion:override", "report:view_course"] as const satisfies readonly Capability[];
