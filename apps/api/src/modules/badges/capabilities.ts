import type { Capability } from "@lms/rbac";

export const capabilities = ["badge:manage", "badge:award"] as const satisfies readonly Capability[];
