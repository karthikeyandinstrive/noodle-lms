import type { Capability } from "@lms/rbac";

export const capabilities = ["calendar:manage_site", "calendar:manage_course"] as const satisfies readonly Capability[];
