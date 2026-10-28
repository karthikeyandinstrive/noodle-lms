import type { Capability } from "@lms/rbac";

export const capabilities = ["lti:manage_tools", "lti:launch"] as const satisfies readonly Capability[];
