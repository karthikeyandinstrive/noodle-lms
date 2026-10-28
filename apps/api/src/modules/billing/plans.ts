/** SaaS plans (pure; no config/DB access so it can be unit-tested). */

export type LimitKind = "users" | "courses";
export type PlanLimits = Record<LimitKind, number | null>;

export const PLANS = {
  free: { id: "free", name: "Free", description: "For trying things out and small teams.", limits: { users: 50, courses: 5 } },
  pro: { id: "pro", name: "Pro", description: "Unlimited users and courses, billed monthly.", limits: { users: null, courses: null } },
} as const satisfies Record<string, { id: string; name: string; description: string; limits: PlanLimits }>;

export type PlanId = keyof typeof PLANS;

export const isPlanId = (plan: string): plan is PlanId => Object.hasOwn(PLANS, plan);

/** Limits of a plan; unknown plans fall back to Free (fail closed). `null` = unlimited. */
export function planLimits(plan: string | null | undefined): PlanLimits {
  return plan && isPlanId(plan) ? PLANS[plan].limits : PLANS.free.limits;
}

/** True when adding `adding` items to `current` would exceed `limit`. */
export function exceedsLimit(limit: number | null, current: number, adding = 1) {
  return limit !== null && current + adding > limit;
}

/** Stripe subscription statuses that keep paid features on (past_due = grace period while Stripe retries). */
const PAID_STATUSES = new Set(["active", "trialing", "past_due"]);

/** Effective organization plan for a Stripe subscription status. */
export function planForSubscriptionStatus(status: string | null | undefined, subscribedPlan: PlanId = "pro"): PlanId {
  return status && PAID_STATUSES.has(status) ? subscribedPlan : "free";
}
