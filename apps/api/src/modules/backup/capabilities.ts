import type { Capability } from "@lms/rbac";

export const capabilities = ["course:backup", "course:restore"] as const satisfies readonly Capability[];
