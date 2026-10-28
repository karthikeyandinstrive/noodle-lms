import type { Capability } from "@lms/rbac";

export const capabilities = ["assignment:submit", "assignment:view_submissions", "assignment:grade"] as const satisfies readonly Capability[];
