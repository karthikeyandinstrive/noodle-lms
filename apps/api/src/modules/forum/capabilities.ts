import type { Capability } from "@lms/rbac";

export const capabilities = [
  "forum:view",
  "forum:start_discussion",
  "forum:reply",
  "forum:moderate",
  "forum:post_news",
] as const satisfies readonly Capability[];
