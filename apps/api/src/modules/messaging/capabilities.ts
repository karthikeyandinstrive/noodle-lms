import type { Capability } from "@lms/rbac";

export const capabilities = ["message:send", "message:send_any"] as const satisfies readonly Capability[];
