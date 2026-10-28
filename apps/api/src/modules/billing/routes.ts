import { eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod, ZodTypeProvider } from "fastify-type-provider-zod";
import Stripe from "stripe";
import { getSystemContext, organizations, subscriptions, withTenant, type DB } from "@lms/db";
import { z } from "zod";
import { config } from "../../config";
import { audit } from "../../core/audit";
import { requireUser } from "../../core/auth";
import { badRequest, conflict, must } from "../../core/errors";
import { requireCapability } from "../../core/rbac";
import { zNullableDate } from "../../core/schemas";
import { claimWebhookEvent, webhookScope } from "../payments/lib";
import { appBaseUrl, providerError } from "../payments/service";
import { PLANS, limitsEnforced, planLimits } from "./plans";
import { applySubscription, isBillingConfigured, organizationForSubscription, platformStripe, requireBillingConfigured, usage } from "./service";

const zLimits = z.object({ users: z.number().int().nullable(), courses: z.number().int().nullable() });

async function requireBillingManage(tx: DB, req: Parameters<typeof requireCapability>[1] & { org: { id: string } }) {
  const system = await getSystemContext(tx, req.org.id);
  await requireCapability(tx, req, "billing:manage", system.id);
}

const ACTIVE = new Set(["active", "trialing", "past_due"]);

export const routes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/plans",
    {
      schema: {
        tags: ["Billing"],
        summary: "Available SaaS plans and their limits",
        response: {
          200: z.object({
            configured: z.boolean(),
            current: z.string(),
            plans: z.array(z.object({ id: z.string(), name: z.string(), description: z.string(), limits: zLimits })),
          }),
        },
      },
    },
    (req) => {
      requireUser(req);
      return {
        configured: isBillingConfigured(),
        current: req.org.plan,
        plans: Object.values(PLANS).map((p) => ({ id: p.id, name: p.name, description: p.description, limits: { ...p.limits } })),
      };
    },
  );

  app.get(
    "/subscription",
    {
      schema: {
        tags: ["Billing"],
        summary: "The organization's subscription, limits and usage",
        response: {
          200: z.object({
            configured: z.boolean(),
            plan: z.string(),
            limits: zLimits,
            usage: z.object({ users: z.number().int(), courses: z.number().int() }),
            subscription: z
              .object({
                plan: z.string(),
                status: z.string(),
                currentPeriodEnd: zNullableDate,
                cancelAtPeriodEnd: z.boolean(),
                hasBillingAccount: z.boolean(),
              })
              .nullable(),
          }),
        },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        await requireBillingManage(tx, req);
        const [org] = await tx.select({ plan: organizations.plan }).from(organizations).where(eq(organizations.id, req.org.id));
        const [sub] = await tx.select().from(subscriptions).where(eq(subscriptions.organizationId, req.org.id)).limit(1);
        const plan = org?.plan ?? "free";
        return {
          configured: isBillingConfigured(),
          plan,
          limits: limitsEnforced(config) ? planLimits(plan) : { users: null, courses: null },
          usage: await usage(tx, req.org.id),
          subscription: sub
            ? { plan: sub.plan, status: sub.status, currentPeriodEnd: sub.currentPeriodEnd, cancelAtPeriodEnd: sub.cancelAtPeriodEnd, hasBillingAccount: !!sub.stripeCustomerId }
            : null,
        };
      }),
  );

  app.post(
    "/checkout",
    {
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
      schema: { tags: ["Billing"], summary: "Start a Stripe Checkout to upgrade to Pro", body: z.object({}).optional(), response: { 200: z.object({ url: z.string() }) } },
    },
    async (req) => {
      const me = requireUser(req);
      requireBillingConfigured();
      const stripe = platformStripe();
      const state = await req.tenant(async (tx) => {
        await requireBillingManage(tx, req);
        const [sub] = await tx.select().from(subscriptions).where(eq(subscriptions.organizationId, req.org.id)).limit(1);
        if (sub?.stripeSubscriptionId && ACTIVE.has(sub.status)) {
          throw conflict("Your organization already has an active subscription. Use the billing portal to manage it.");
        }
        const [org] = await tx.select().from(organizations).where(eq(organizations.id, req.org.id));
        return { sub, org: must(org, "Organization") };
      });

      let customerId = state.sub?.stripeCustomerId ?? null;
      try {
        if (!customerId) {
          const customer = await stripe.customers.create(
            { name: state.org.name, email: me.email, metadata: { organizationId: req.org.id, slug: state.org.slug } },
            { idempotencyKey: `customer:${req.org.id}` },
          );
          customerId = customer.id;
          const id = customerId;
          await req.tenant(async (tx) => {
            const [existing] = await tx.select().from(subscriptions).where(eq(subscriptions.organizationId, req.org.id)).limit(1);
            if (existing) await tx.update(subscriptions).set({ stripeCustomerId: id }).where(eq(subscriptions.id, existing.id));
            else await tx.insert(subscriptions).values({ organizationId: req.org.id, plan: state.org.plan, status: "none", stripeCustomerId: id });
          });
        }
        const base = appBaseUrl(req);
        const session = await stripe.checkout.sessions.create({
          mode: "subscription",
          customer: customerId,
          client_reference_id: req.org.id,
          line_items: [{ price: config.STRIPE_PRICE_PRO!, quantity: 1 }],
          metadata: { organizationId: req.org.id },
          subscription_data: { metadata: { organizationId: req.org.id } },
          allow_promotion_codes: true,
          success_url: `${base}/admin/billing?checkout=success`,
          cancel_url: `${base}/admin/billing?checkout=cancelled`,
        });
        if (!session.url) throw new Error("No checkout URL");
        await req.tenant((tx) => audit(tx, req, "billing.checkout_started", { type: "organization", id: req.org.id }, { plan: "pro" }));
        return { url: session.url };
      } catch (err) {
        req.log.warn({ err: (err as { type?: string }).type ?? (err as Error).name }, "billing checkout failed");
        throw providerError("stripe", "start the checkout");
      }
    },
  );

  app.post(
    "/portal",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: { tags: ["Billing"], summary: "Open the Stripe customer portal (invoices, payment method, cancel)", body: z.object({}).optional(), response: { 200: z.object({ url: z.string() }) } },
    },
    async (req) => {
      requireUser(req);
      requireBillingConfigured();
      const customerId = await req.tenant(async (tx) => {
        await requireBillingManage(tx, req);
        const [sub] = await tx.select().from(subscriptions).where(eq(subscriptions.organizationId, req.org.id)).limit(1);
        if (!sub?.stripeCustomerId) throw badRequest("There is no billing account yet. Upgrade to create one.");
        await audit(tx, req, "billing.portal_opened", { type: "organization", id: req.org.id });
        return sub.stripeCustomerId;
      });
      try {
        const session = await platformStripe().billingPortal.sessions.create({ customer: customerId, return_url: `${appBaseUrl(req)}/admin/billing` });
        return { url: session.url };
      } catch (err) {
        req.log.warn({ err: (err as { type?: string }).type ?? (err as Error).name }, "billing portal failed");
        throw providerError("stripe", "open the billing portal");
      }
    },
  );

  // ─── Platform Stripe webhook (raw body) ─────────────────────────────────

  await app.register(async (instance) => {
    const scope = instance.withTypeProvider<ZodTypeProvider>();
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: 512 * 1024 }, (_req, body, done) => done(null, body));

    scope.post(
      "/webhooks/stripe",
      {
        config: { tenant: false, rateLimit: { max: 1000, timeWindow: "1 minute" } },
        schema: { tags: ["Billing"], summary: "Stripe webhook for platform subscriptions", response: { 200: z.object({ received: z.literal(true) }) } },
      },
      async (req) => {
        requireBillingConfigured();
        const raw = req.body;
        const signature = req.headers["stripe-signature"];
        if (!Buffer.isBuffer(raw) || typeof signature !== "string") throw badRequest("Invalid webhook request");
        let event: Stripe.Event;
        try {
          event = Stripe.webhooks.constructEvent(raw, signature, config.STRIPE_WEBHOOK_SECRET!);
        } catch {
          req.log.warn("billing webhook signature rejected");
          throw badRequest("Invalid signature");
        }

        // Resolve the subscription id this event concerns, then fetch its CURRENT state
        // (events can arrive out of order; the latest object is authoritative).
        let subscriptionId: string | null = null;
        if (event.type === "checkout.session.completed") {
          const session = event.data.object;
          if (session.mode === "subscription") subscriptionId = typeof session.subscription === "string" ? session.subscription : (session.subscription?.id ?? null);
        } else if (
          event.type === "customer.subscription.created" ||
          event.type === "customer.subscription.updated" ||
          event.type === "customer.subscription.deleted" ||
          event.type === "customer.subscription.paused" ||
          event.type === "customer.subscription.resumed"
        ) {
          subscriptionId = event.data.object.id;
        }
        if (!subscriptionId) return { received: true as const };

        let sub: Stripe.Subscription;
        try {
          sub = await platformStripe().subscriptions.retrieve(subscriptionId);
        } catch (err) {
          req.log.warn({ err: (err as { type?: string }).type ?? (err as Error).name, subscriptionId }, "billing: could not fetch subscription");
          throw providerError("stripe", "load the subscription");
        }
        const organizationId = await organizationForSubscription(sub);
        if (!organizationId) {
          req.log.warn({ subscriptionId, eventId: event.id }, "billing: subscription does not map to an organization");
          return { received: true as const };
        }
        await withTenant(organizationId, async (tx) => {
          if (!(await claimWebhookEvent(tx, { scope: webhookScope("stripe", "platform"), eventId: event.id, type: event.type }))) return;
          await applySubscription(tx, organizationId, sub, event.id);
        });
        return { received: true as const };
      },
    );
  });
};
