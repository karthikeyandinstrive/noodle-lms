import type { Capability } from "@lms/rbac";

export const capabilities = ["scorm:attempt", "scorm:view_reports"] as const satisfies readonly Capability[];
