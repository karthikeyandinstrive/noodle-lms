import type { Capability } from "@lms/rbac";

export const capabilities = ["report:view_course", "report:view_site"] as const satisfies readonly Capability[];
