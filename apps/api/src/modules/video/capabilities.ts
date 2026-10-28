import type { Capability } from "@lms/rbac";

export const capabilities = ["video:join", "video:moderate"] as const satisfies readonly Capability[];
