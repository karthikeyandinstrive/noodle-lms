import type { Capability } from "@lms/rbac";

export const capabilities = ["quiz:attempt", "quiz:preview", "quiz:view_reports", "quiz:grade"] as const satisfies readonly Capability[];
