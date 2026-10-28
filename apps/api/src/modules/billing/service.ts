import { and, count, eq, isNull, or } from "drizzle-orm";
import Stripe from "stripe";
import { courses, organizations, subscriptions, systemDb, users, type DB } from "@lms/db";
import { config } from "../../config";
import { AppError, badRequest } from "../../core/errors";
import { logger } from "../../core/logger";
import { auditSystem } from "../payments/service";
import { PLANS, exceedsLimit, planForSubscriptionStatus, planLimits, type LimitKind, type PlanId } from "./plans";

export { PLANS, planLimits, type LimitKind, type PlanId } from "./plans";

// ─── Configuration ──────────────────────────────────────────────────────────

export function isBillingConfigured() {
  return !!(config.STRIPE_SECRET_KEY && config.STRIPE_PRICE_PRO && config.STRIPE_WEBHOOK_SECRET);
}

export function requireBillingConfigured() {
  if (!isBillingConfigured()) throw badRequest("Billing is not configured");
}

let stripe: Stripe | undefined;
/** Platform Stripe account (the organization pays the platform). */
export function platformStripe() {
  requireBillingConfigured();
  stripe ??= new Stripe(config.STRIPE_SECRET_KEY!, { maxNetworkRetries: 2, timeout: 20_000, appInfo: { name: "lms-billing" } });
  return stripe;
}

export function setup() {
  const set = [config.STRIPE_SECRET_KEY, config.STRIPE_PRICE_PRO, config.STRIPE_WEBHOOK_SECRET].filter(Boolean).length;
  if (set > 0 && set < 3) logger.warn("billing: STRIPE_SECRET_KEY, STRIPE_PRICE_PRO and STRIPE_WEBHOOK_SECRET must all be set; billing is disabled");
}

// ─── Limits (call from other modules inside their tenant transaction) ───────

export async function usage(tx: DB, organizationId: string): Promise<Record<LimitKind, number>> {
  const [[u], [c]] = (await Promise.all([
    tx.select({ n: count() }).from(users).where(and(eq(users.organizationId, organizationId), isNull(users.deletedAt))),
    tx.select({ n: count() }).from(courses).where(eq(courses.organizationId, organizationId)),
  ])) as [[{ n: number }], [{ n: number }]];
  return { users: Number(u.n), courses: Number(c.n) };
}

/**
 * Throws 402 PLAN_LIMIT when adding `adding` users/courses would exceed the
 * organization's plan. Not wired into other modules yet; call it before inserts:
 * `await assertWithinLimits(tx, req.org.id, "users", rows.length)`.
 */
export async function assertWithinLimits(tx: DB, organizationId: string, kind: LimitKind, adding = 1) {
  const [org] = await tx.select({ plan: organizations.plan }).from(organizations).where(eq(organizations.id, organizationId)).limit(1);
  const plan = org?.plan ?? "free";
  const limit = planLimits(plan)[kind];
  if (limit === null) return;
  const current = (await usage(tx, organizationId))[kind];
  if (exceedsLimit(limit, current, adding)) {
    const name = (PLANS as Record<string, { name: string }>)[plan]?.name ?? "current";
    throw new AppError(402, "PLAN_LIMIT", `Your ${name} plan allows up to ${limit} ${kind}. Upgrade your subscription to add more.`, { kind, limit, current });
  }
}

// ─── Subscription sync (webhooks) ───────────────────────────────────────────

const stripeId = (v: string | { id: string } | null | undefined) => (typeof v === "string" ? v : (v?.id ?? null));

/** Finds the organization a Stripe subscription belongs to (metadata first, then stored ids). Cross-tenant lookup. */
export async function organizationForSubscription(sub: Stripe.Subscription): Promise<string | null> {
  const fromMeta = sub.metadata?.organizationId;
  const db = await systemDb();
  const customerId = stripeId(sub.customer);
  const [row] = await db
    .select({ organizationId: subscriptions.organizationId, stripeCustomerId: subscriptions.stripeCustomerId })
    .from(subscriptions)
    .where(
      or(
        eq(subscriptions.stripeSubscriptionId, sub.id),
        customerId ? eq(subscriptions.stripeCustomerId, customerId) : undefined,
        fromMeta && /^[0-9a-f-]{36}$/i.test(fromMeta) ? eq(subscriptions.organizationId, fromMeta) : undefined,
      ),
    )
    .limit(1);
  if (!row) {
    // No local record yet: trust signed metadata only if the organization exists.
    if (!fromMeta || !/^[0-9a-f-]{36}$/i.test(fromMeta)) return null;
    const [org] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, fromMeta)).limit(1);
    return org?.id ?? null;
  }
  if (row.stripeCustomerId && customerId && row.stripeCustomerId !== customerId) {
    logger.error({ organizationId: row.organizationId, subscriptionId: sub.id }, "billing: subscription customer does not match the organization");
    return null;
  }
  return row.organizationId;
}

/** Applies the current state of a Stripe subscription to the organization (idempotent). */
export async function applySubscription(tx: DB, organizationId: string, sub: Stripe.Subscription, eventId: string) {
  const pricedPro = sub.items.data.some((i) => i.price?.id === config.STRIPE_PRICE_PRO);
  const subscribedPlan: PlanId = pricedPro ? "pro" : "free";
  const effective = planForSubscriptionStatus(sub.status, subscribedPlan);
  const values = {
    plan: subscribedPlan,
    status: sub.status,
    stripeCustomerId: stripeId(sub.customer),
    stripeSubscriptionId: sub.id,
    currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000) : null,
    cancelAtPeriodEnd: sub.cancel_at_period_end,
  };
  const [existing] = await tx.select().from(subscriptions).where(eq(subscriptions.organizationId, organizationId)).limit(1);
  // An older, replaced subscription must not overwrite the current one.
  if (existing?.stripeSubscriptionId && existing.stripeSubscriptionId !== sub.id && sub.status === "canceled" && ["active", "trialing", "past_due"].includes(existing.status)) {
    return;
  }
  if (existing) await tx.update(subscriptions).set(values).where(eq(subscriptions.id, existing.id));
  else await tx.insert(subscriptions).values({ ...values, organizationId });

  const [org] = await tx.select({ plan: organizations.plan }).from(organizations).where(eq(organizations.id, organizationId)).limit(1);
  if (org && org.plan !== effective) {
    await tx.update(organizations).set({ plan: effective }).where(eq(organizations.id, organizationId));
    await auditSystem(tx, {
      organizationId,
      action: "billing.plan_changed",
      target: { type: "organization", id: organizationId },
      metadata: { from: org.plan, to: effective, status: sub.status, eventId },
    });
  }
}
