import type { Capability } from "@lms/rbac";

export const capabilities = ["attendance:take", "attendance:view_all", "attendance:self_mark"] as const satisfies readonly Capability[];
