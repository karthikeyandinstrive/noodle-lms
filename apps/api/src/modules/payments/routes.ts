import { and, count, desc, eq, ilike, or } from "drizzle-orm";
import type { FastifyPluginAsyncZod, ZodTypeProvider } from "fastify-type-provider-zod";
import Stripe from "stripe";
import { courses, enrolments, getSystemContext, orders, paymentGateways, payments, users, withTenant, type DB } from "@lms/db";
import { z } from "zod";
import { config } from "../../config";
import { audit } from "../../core/audit";
import { requireUser } from "../../core/auth";
import { encryptSecret, maskSecret, sha256 } from "../../core/crypto";
import { badRequest, conflict, must, notFound } from "../../core/errors";
import { emit } from "../../core/events";
import { requireCapability } from "../../core/rbac";
import { offset, paged, zDate, zId, zNullableDate, zOk, ok, zPagination } from "../../core/schemas";
import { unenrolUser } from "../courses/service";
import {
  claimWebhookEvent,
  toProviderAmount,
  validateCharge,
  validateGatewayKeys,
  verifyRazorpayPaymentSignature,
  verifyRazorpayWebhookSignature,
  webhookScope,
  type Provider,
} from "./lib";
import {
  appBaseUrl,
  auditSystem,
  closePendingOrder,
  findOrder,
  findOrderByProviderRef,
  fulfilOrder,
  gatewaySecrets,
  loadGateway,
  providerError,
  razorpayApi,
  recordProviderRefund,
  stripeClient,
  type FulfilResult,
  type GatewayRow,
} from "./service";

// ─── Schemas ────────────────────────────────────────────────────────────────

const PROVIDERS = ["stripe", "razorpay"] as const;
const zProvider = z.enum(PROVIDERS);
const zOrderStatus = z.enum(["pending", "paid", "failed", "refunded", "cancelled"]);

const zGateway = z.object({
  provider: zProvider,
  configured: z.boolean(),
  enabled: z.boolean(),
  testMode: z.boolean(),
  publicKey: z.string().nullable(),
  secretKey: z.string().nullable().describe("Masked"),
  webhookSecret: z.string().nullable().describe("Masked"),
  webhookUrl: z.string(),
  updatedAt: zNullableDate,
});

const zGatewayInput = z.object({
  enabled: z.boolean(),
  testMode: z.boolean(),
  publicKey: z.string().trim().min(1).max(200),
  /** Omit to keep the stored secret. */
  secretKey: z.string().trim().min(1).max(300).optional(),
  /** Omit to keep, null to clear. */
  webhookSecret: z.string().trim().min(1).max(300).nullable().optional(),
});

const zOrder = z.object({
  id: zId,
  status: zOrderStatus,
  provider: zProvider,
  amountCents: z.number().int(),
  currency: z.string(),
  refundedCents: z.number().int(),
  providerRef: z.string().nullable(),
  createdAt: zDate,
  updatedAt: zDate,
  course: z.object({ id: zId, fullname: z.string() }),
});

const zAdminOrder = zOrder.extend({
  user: z.object({ id: zId, firstName: z.string(), lastName: z.string(), email: z.string() }),
  providerPaymentId: z.string().nullable(),
});

const zCheckoutResult = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("stripe"), orderId: zId, url: z.string() }),
  z.object({
    provider: z.literal("razorpay"),
    orderId: zId,
    razorpay: z.object({
      keyId: z.string(),
      orderId: z.string(),
      amount: z.number().int(),
      currency: z.string(),
      name: z.string(),
      description: z.string(),
      prefill: z.object({ name: z.string(), email: z.string() }),
    }),
  }),
]);

const zWebhookAck = z.object({ received: z.literal(true) });

// ─── Helpers ────────────────────────────────────────────────────────────────

async function requirePaymentManage(tx: DB, req: Parameters<typeof requireCapability>[1] & { org: { id: string } }) {
  const system = await getSystemContext(tx, req.org.id);
  await requireCapability(tx, req, "payment:manage", system.id);
}

const webhookUrl = (provider: Provider, organizationId: string) =>
  `${config.APP_URL.replace(/\/$/, "")}/api/v1/payments/webhooks/${provider}/${organizationId}`;

function toGateway(provider: Provider, organizationId: string, row: GatewayRow | null): z.infer<typeof zGateway> {
  if (!row) {
    return { provider, configured: false, enabled: false, testMode: true, publicKey: null, secretKey: null, webhookSecret: null, webhookUrl: webhookUrl(provider, organizationId), updatedAt: null };
  }
  const s = gatewaySecrets(row);
  return {
    provider,
    configured: true,
    enabled: row.enabled,
    testMode: row.testMode,
    publicKey: row.publicKey,
    secretKey: maskSecret(s.secretKey),
    webhookSecret: s.webhookSecret ? maskSecret(s.webhookSecret) : null,
    webhookUrl: webhookUrl(provider, organizationId),
    updatedAt: row.updatedAt,
  };
}

async function emitFulfilment(result: FulfilResult) {
  if (!result) return;
  await emit("payment.succeeded", result.payment);
  if (result.enrolled) await emit("user.enrolled", result.enrolled);
}

const stripeId = (v: string | { id: string } | null | undefined) => (typeof v === "string" ? v : (v?.id ?? null));

/** Applies one verified Stripe event for an organization's course sales. */
async function handleStripeEvent(tx: DB, organizationId: string, event: Stripe.Event): Promise<FulfilResult[]> {
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const session = event.data.object;
      if (session.mode !== "payment" || session.payment_status !== "paid") return [];
      const order = await findOrderByProviderRef(tx, "stripe", session.id);
      if (!order || order.organizationId !== organizationId || (session.metadata?.orderId && session.metadata.orderId !== order.id)) {
        await auditSystem(tx, { organizationId, action: "payment.unmatched_webhook", metadata: { provider: "stripe", type: event.type, eventId: event.id } });
        return [];
      }
      const result = await fulfilOrder(tx, {
        order,
        providerPaymentId: stripeId(session.payment_intent) ?? session.id,
        paidAmount: session.amount_total,
        paidCurrency: session.currency,
        source: "webhook",
        raw: { eventId: event.id, sessionId: session.id, paymentIntent: stripeId(session.payment_intent) },
      });
      return [result];
    }
    case "checkout.session.expired":
    case "checkout.session.async_payment_failed": {
      const session = event.data.object;
      const order = await findOrderByProviderRef(tx, "stripe", session.id);
      if (order) await closePendingOrder(tx, order.id, event.type === "checkout.session.expired" ? "cancelled" : "failed");
      return [];
    }
    case "charge.refunded": {
      const charge = event.data.object;
      const pi = stripeId(charge.payment_intent);
      if (pi) await recordProviderRefund(tx, { provider: "stripe", providerPaymentId: pi, refundedAmount: charge.amount_refunded, currency: charge.currency });
      return [];
    }
    default:
      return [];
  }
}

type RazorpayWebhook = {
  event: string;
  payload?: {
    payment?: { entity?: { id: string; order_id: string | null; amount: number; currency: string; status: string; amount_refunded?: number } };
    refund?: { entity?: { payment_id: string; amount: number; currency: string } };
  };
};

async function handleRazorpayEvent(tx: DB, organizationId: string, body: RazorpayWebhook, eventId: string): Promise<FulfilResult[]> {
  const payment = body.payload?.payment?.entity;
  switch (body.event) {
    case "payment.captured":
    case "order.paid": {
      if (!payment?.order_id || payment.status !== "captured") return [];
      const order = await findOrderByProviderRef(tx, "razorpay", payment.order_id);
      if (!order || order.organizationId !== organizationId) {
        await auditSystem(tx, { organizationId, action: "payment.unmatched_webhook", metadata: { provider: "razorpay", type: body.event, eventId } });
        return [];
      }
      return [
        await fulfilOrder(tx, {
          order,
          providerPaymentId: payment.id,
          paidAmount: payment.amount,
          paidCurrency: payment.currency,
          source: "webhook",
          raw: { eventId, paymentId: payment.id, razorpayOrderId: payment.order_id },
        }),
      ];
    }
    case "refund.processed": {
      const refund = body.payload?.refund?.entity;
      if (!refund) return [];
      const refunded = payment?.amount_refunded ?? refund.amount;
      await recordProviderRefund(tx, { provider: "razorpay", providerPaymentId: refund.payment_id, refundedAmount: refunded, currency: refund.currency });
      return [];
    }
    default:
      return [];
  }
}

// ─── Routes ─────────────────────────────────────────────────────────────────

export const routes: FastifyPluginAsyncZod = async (app) => {
  // ─── Gateway configuration (admin) ──────────────────────────────────────

  app.get(
    "/gateways",
    { schema: { tags: ["Payments"], summary: "Payment gateway configuration (secrets masked)", response: { 200: z.array(zGateway) } } },
    (req) =>
      req.tenant(async (tx) => {
        await requirePaymentManage(tx, req);
        const rows = await tx.select().from(paymentGateways);
        return PROVIDERS.map((p) => toGateway(p, req.org.id, rows.find((r) => r.provider === p) ?? null));
      }),
  );

  app.get(
    "/gateways/public",
    {
      schema: {
        tags: ["Payments"],
        summary: "Enabled payment methods for checkout (public keys only)",
        response: { 200: z.array(z.object({ provider: zProvider, publicKey: z.string(), testMode: z.boolean() })) },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        const rows = await tx
          .select({ provider: paymentGateways.provider, publicKey: paymentGateways.publicKey, testMode: paymentGateways.testMode, webhookSecretEnc: paymentGateways.webhookSecretEnc })
          .from(paymentGateways)
          .where(eq(paymentGateways.enabled, true));
        // Stripe can only confirm payments through its webhook.
        return rows.filter((r) => r.provider !== "stripe" || r.webhookSecretEnc).map(({ provider, publicKey, testMode }) => ({ provider, publicKey, testMode }));
      }),
  );

  app.put(
    "/gateways/:provider",
    {
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        tags: ["Payments"],
        summary: "Create or update a gateway (secrets are encrypted at rest and never returned)",
        params: z.object({ provider: zProvider }),
        body: zGatewayInput,
        response: { 200: zGateway },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        await requirePaymentManage(tx, req);
        const provider = req.params.provider;
        const input = req.body;
        const existing = await loadGateway(tx, provider);
        const current = existing ? gatewaySecrets(existing) : null;
        const secretKey = input.secretKey ?? current?.secretKey;
        if (!secretKey) throw badRequest("A secret key is required");
        const webhookSecret = input.webhookSecret === undefined ? (current?.webhookSecret ?? null) : input.webhookSecret;
        const problem = validateGatewayKeys({ provider, publicKey: input.publicKey, secretKey, webhookSecret: webhookSecret ?? undefined, testMode: input.testMode });
        if (problem) throw badRequest(problem);
        if (input.enabled && provider === "stripe" && !webhookSecret) {
          throw badRequest("Stripe needs a webhook signing secret before it can be enabled (payments are confirmed by webhook)");
        }
        const values = {
          enabled: input.enabled,
          testMode: input.testMode,
          publicKey: input.publicKey,
          secretKeyEnc: input.secretKey ? encryptSecret(input.secretKey) : existing!.secretKeyEnc,
          webhookSecretEnc:
            input.webhookSecret === undefined ? (existing?.webhookSecretEnc ?? null) : input.webhookSecret ? encryptSecret(input.webhookSecret) : null,
        };
        const [row] = existing
          ? await tx.update(paymentGateways).set(values).where(eq(paymentGateways.id, existing.id)).returning()
          : await tx.insert(paymentGateways).values({ ...values, organizationId: req.org.id, provider }).returning();
        await audit(tx, req, existing ? "payment.gateway_updated" : "payment.gateway_created", { type: "payment_gateway", id: row!.id }, {
          provider,
          enabled: input.enabled,
          testMode: input.testMode,
          secretKeyChanged: !!input.secretKey,
          webhookSecretChanged: input.webhookSecret !== undefined,
        });
        return toGateway(provider, req.org.id, row!);
      }),
  );

  app.delete(
    "/gateways/:provider",
    { schema: { tags: ["Payments"], summary: "Remove a gateway's credentials", params: z.object({ provider: zProvider }), response: { 200: zOk } } },
    async (req) => {
      await req.tenant(async (tx) => {
        await requirePaymentManage(tx, req);
        const existing = must(await loadGateway(tx, req.params.provider), "Gateway");
        await tx.delete(paymentGateways).where(eq(paymentGateways.id, existing.id));
        await audit(tx, req, "payment.gateway_deleted", { type: "payment_gateway", id: existing.id }, { provider: req.params.provider });
      });
      return ok;
    },
  );

  app.post(
    "/gateways/:provider/test",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["Payments"],
        summary: "Check the saved credentials against the provider",
        params: z.object({ provider: zProvider }),
        response: { 200: z.object({ ok: z.boolean(), message: z.string() }) },
      },
    },
    async (req) => {
      const secrets = await req.tenant(async (tx) => {
        await requirePaymentManage(tx, req);
        return gatewaySecrets(must(await loadGateway(tx, req.params.provider), "Gateway"));
      });
      try {
        if (req.params.provider === "stripe") await stripeClient(secrets.secretKey).balance.retrieve();
        else await razorpayApi.ping({ keyId: secrets.publicKey, keySecret: secrets.secretKey });
        return { ok: true, message: "Credentials accepted by the provider" };
      } catch (err) {
        const name = (err as { type?: string; name?: string }).type ?? (err as Error).name ?? "Error";
        return { ok: false, message: `Connection failed (${name})` };
      }
    },
  );

  // ─── Checkout ───────────────────────────────────────────────────────────

  app.post(
    "/checkout",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["Payments"],
        summary: "Start paying for a course. The amount always comes from the course, never the client.",
        body: z.object({ courseId: zId, provider: zProvider }),
        response: { 200: zCheckoutResult },
      },
    },
    async (req) => {
      const me = requireUser(req);
      const { provider } = req.body;
      const prep = await req.tenant(async (tx) => {
        const [course] = await tx.select().from(courses).where(and(eq(courses.id, req.body.courseId), eq(courses.visible, true))).limit(1);
        if (!course) throw notFound("Course");
        const [enrolment] = await tx
          .select({ status: enrolments.status })
          .from(enrolments)
          .where(and(eq(enrolments.courseId, course.id), eq(enrolments.userId, me.id)))
          .limit(1);
        if (enrolment?.status === "active") throw conflict("You are already enrolled in this course");
        if (enrolment) throw badRequest("Your enrolment in this course is suspended. Please contact the course administrator.");
        const charge = validateCharge(course.priceCents, course.currency, provider);
        if (!charge.ok) throw badRequest(charge.reason);
        const gateway = await loadGateway(tx, provider);
        if (!gateway?.enabled) throw badRequest("This payment method is not available");
        const secrets = gatewaySecrets(gateway);
        if (provider === "stripe" && !secrets.webhookSecret) throw badRequest("This payment method is not available");
        const [order] = await tx
          .insert(orders)
          .values({ organizationId: req.org.id, userId: me.id, courseId: course.id, amountCents: course.priceCents!, currency: charge.currency, status: "pending", provider })
          .returning();
        await audit(tx, req, "payment.checkout_started", { type: "order", id: order!.id }, { provider, courseId: course.id, amountCents: order!.amountCents, currency: order!.currency });
        return { course, order: order!, amount: charge.amount, currency: charge.currency, secrets };
      });

      const { course, order, secrets } = prep;
      const markFailed = () => req.tenant((tx) => closePendingOrder(tx, order.id, "failed"));
      const setRef = (ref: string) => req.tenant((tx) => tx.update(orders).set({ providerRef: ref }).where(eq(orders.id, order.id)));

      if (provider === "stripe") {
        const base = appBaseUrl(req);
        const metadata = { orderId: order.id, organizationId: req.org.id, courseId: course.id, userId: me.id };
        let session: Stripe.Checkout.Session;
        try {
          session = await stripeClient(secrets.secretKey).checkout.sessions.create(
            {
              mode: "payment",
              client_reference_id: order.id,
              customer_email: me.email,
              line_items: [
                {
                  quantity: 1,
                  price_data: { currency: prep.currency.toLowerCase(), unit_amount: prep.amount, product_data: { name: course.fullname.slice(0, 250) } },
                },
              ],
              metadata,
              payment_intent_data: { metadata },
              success_url: `${base}/courses/${course.id}?payment=success`,
              cancel_url: `${base}/courses/${course.id}?payment=cancelled`,
            },
            { idempotencyKey: `checkout:${order.id}` },
          );
        } catch (err) {
          req.log.warn({ err: (err as { type?: string }).type ?? (err as Error).name, orderId: order.id }, "stripe checkout failed");
          await markFailed();
          throw providerError("stripe", "start the checkout");
        }
        if (!session.url) {
          await markFailed();
          throw providerError("stripe", "start the checkout");
        }
        await setRef(session.id);
        return { provider: "stripe" as const, orderId: order.id, url: session.url };
      }

      let rzpOrder;
      try {
        rzpOrder = await razorpayApi.createOrder(
          { keyId: secrets.publicKey, keySecret: secrets.secretKey },
          { amount: prep.amount, currency: prep.currency, receipt: order.id, notes: { orderId: order.id, organizationId: req.org.id, courseId: course.id } },
        );
      } catch (err) {
        await markFailed();
        throw err;
      }
      if (rzpOrder.amount !== prep.amount || rzpOrder.currency.toUpperCase() !== prep.currency) {
        await markFailed();
        throw providerError("razorpay", "create the order");
      }
      await setRef(rzpOrder.id);
      return {
        provider: "razorpay" as const,
        orderId: order.id,
        razorpay: {
          keyId: secrets.publicKey,
          orderId: rzpOrder.id,
          amount: rzpOrder.amount,
          currency: rzpOrder.currency,
          name: req.org.name,
          description: course.fullname.slice(0, 250),
          prefill: { name: `${me.firstName} ${me.lastName}`, email: me.email },
        },
      };
    },
  );

  app.post(
    "/razorpay/verify",
    {
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        tags: ["Payments"],
        summary: "Confirm a Razorpay Checkout payment (signature-verified, then confirmed with the Razorpay API)",
        body: z.object({
          orderId: zId,
          razorpay_payment_id: z.string().min(1).max(100),
          razorpay_signature: z.string().min(1).max(256),
        }),
        response: { 200: z.object({ status: zOrderStatus, courseId: zId }) },
      },
    },
    async (req) => {
      const me = requireUser(req);
      const { order, secrets } = await req.tenant(async (tx) => {
        const order = await findOrder(tx, req.body.orderId);
        if (!order || order.userId !== me.id || order.provider !== "razorpay" || !order.providerRef) throw notFound("Order");
        const gateway = must(await loadGateway(tx, "razorpay"), "Gateway");
        return { order, secrets: gatewaySecrets(gateway) };
      });
      if (order.status === "paid") return { status: order.status, courseId: order.courseId };

      const valid = verifyRazorpayPaymentSignature({
        razorpayOrderId: order.providerRef!,
        razorpayPaymentId: req.body.razorpay_payment_id,
        signature: req.body.razorpay_signature,
        keySecret: secrets.secretKey,
      });
      if (!valid) {
        await req.tenant((tx) => audit(tx, req, "payment.signature_invalid", { type: "order", id: order.id }, { provider: "razorpay" }));
        throw badRequest("Payment verification failed");
      }

      // Signature proves the payment belongs to our order; confirm status and amount with the API.
      const creds = { keyId: secrets.publicKey, keySecret: secrets.secretKey };
      let payment = await razorpayApi.fetchPayment(creds, req.body.razorpay_payment_id);
      if (payment.order_id !== order.providerRef) throw badRequest("Payment verification failed");
      if (payment.status === "authorized") {
        payment = await razorpayApi.capture(creds, payment.id, toProviderAmount(order.amountCents, order.currency), order.currency);
      }
      if (payment.status !== "captured") throw badRequest("The payment has not been completed");

      const result = await req.tenant(async (tx) => {
        const fresh = must(await findOrder(tx, order.id), "Order");
        const r = await fulfilOrder(tx, {
          order: fresh,
          providerPaymentId: payment.id,
          paidAmount: payment.amount,
          paidCurrency: payment.currency,
          source: "client_verify",
          raw: { paymentId: payment.id, razorpayOrderId: payment.order_id },
        });
        const after = must(await findOrder(tx, order.id), "Order");
        return { r, status: after.status };
      });
      await emitFulfilment(result.r);
      if (result.status !== "paid") throw badRequest("Payment verification failed");
      return { status: result.status, courseId: order.courseId };
    },
  );

  // ─── Orders ─────────────────────────────────────────────────────────────

  app.get(
    "/orders/me",
    { schema: { tags: ["Payments"], summary: "My orders", response: { 200: z.array(zOrder) } } },
    (req) => {
      const me = requireUser(req);
      return req.tenant(async (tx) => {
        const rows = await tx
          .select({ o: orders, course: { id: courses.id, fullname: courses.fullname }, refundedCents: payments.refundedCents })
          .from(orders)
          .innerJoin(courses, eq(courses.id, orders.courseId))
          .leftJoin(payments, eq(payments.orderId, orders.id))
          .where(eq(orders.userId, me.id))
          .orderBy(desc(orders.createdAt))
          .limit(200);
        return rows.map((r) => ({ ...r.o, course: r.course, refundedCents: r.refundedCents ?? 0 }));
      });
    },
  );

  app.get(
    "/orders",
    {
      schema: {
        tags: ["Payments"],
        summary: "All orders (admin)",
        querystring: zPagination.extend({
          status: zOrderStatus.optional(),
          provider: zProvider.optional(),
          courseId: zId.optional(),
          userId: zId.optional(),
          search: z.string().trim().max(100).optional(),
        }),
        response: { 200: paged(zAdminOrder) },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        await requirePaymentManage(tx, req);
        const q = req.query;
        const where = and(
          q.status ? eq(orders.status, q.status) : undefined,
          q.provider ? eq(orders.provider, q.provider) : undefined,
          q.courseId ? eq(orders.courseId, q.courseId) : undefined,
          q.userId ? eq(orders.userId, q.userId) : undefined,
          q.search
            ? or(
                ilike(users.email, `%${q.search}%`),
                ilike(users.firstName, `%${q.search}%`),
                ilike(users.lastName, `%${q.search}%`),
                ilike(courses.fullname, `%${q.search}%`),
                eq(orders.providerRef, q.search),
              )
            : undefined,
        );
        const rows = await tx
          .select({
            o: orders,
            user: { id: users.id, firstName: users.firstName, lastName: users.lastName, email: users.email },
            course: { id: courses.id, fullname: courses.fullname },
            refundedCents: payments.refundedCents,
            providerPaymentId: payments.providerPaymentId,
          })
          .from(orders)
          .innerJoin(users, eq(users.id, orders.userId))
          .innerJoin(courses, eq(courses.id, orders.courseId))
          .leftJoin(payments, eq(payments.orderId, orders.id))
          .where(where)
          .orderBy(desc(orders.createdAt))
          .limit(q.pageSize)
          .offset(offset(q));
        const [{ total }] = (await tx
          .select({ total: count() })
          .from(orders)
          .innerJoin(users, eq(users.id, orders.userId))
          .innerJoin(courses, eq(courses.id, orders.courseId))
          .where(where)) as [{ total: number }];
        return {
          items: rows.map((r) => ({ ...r.o, user: r.user, course: r.course, refundedCents: r.refundedCents ?? 0, providerPaymentId: r.providerPaymentId ?? null })),
          total,
          page: q.page,
          pageSize: q.pageSize,
        };
      }),
  );

  app.post(
    "/orders/:id/refund",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["Payments"],
        summary: "Refund a paid order (full by default) through the provider; optionally unenrol the buyer",
        params: z.object({ id: zId }),
        body: z.object({
          amountCents: z.number().int().positive().optional(),
          unenrol: z.boolean().default(false),
          reason: z.string().trim().max(500).optional(),
        }),
        response: { 200: z.object({ status: zOrderStatus, refundedCents: z.number().int() }) },
      },
    },
    async (req) => {
      const prep = await req.tenant(async (tx) => {
        await requirePaymentManage(tx, req);
        const order = must(await findOrder(tx, req.params.id), "Order");
        if (order.status !== "paid") throw badRequest("Only paid orders can be refunded");
        const [payment] = await tx.select().from(payments).where(eq(payments.orderId, order.id)).limit(1);
        if (!payment) throw badRequest("No payment is recorded for this order");
        const remaining = payment.amountCents - payment.refundedCents;
        const amountCents = req.body.amountCents ?? remaining;
        if (amountCents <= 0 || amountCents > remaining) throw badRequest(`You can refund at most ${remaining} (minor units)`);
        const providerAmount = toProviderAmount(amountCents, order.currency);
        if (!Number.isInteger(providerAmount)) throw badRequest(`${order.currency} refunds must be whole units`);
        const gateway = must(await loadGateway(tx, order.provider), "Gateway");
        return { order, payment, amountCents, providerAmount, secrets: gatewaySecrets(gateway) };
      });
      const { order, payment, secrets } = prep;
      // Same key for a retried identical request → the provider will not refund twice.
      const idempotencyKey = `refund:${order.id}:${payment.refundedCents}:${prep.amountCents}`;

      let refundId: string;
      if (order.provider === "stripe") {
        try {
          const refund = await stripeClient(secrets.secretKey).refunds.create(
            { payment_intent: payment.providerPaymentId, amount: prep.providerAmount, reason: "requested_by_customer", metadata: { orderId: order.id } },
            { idempotencyKey },
          );
          refundId = refund.id;
        } catch (err) {
          req.log.warn({ err: (err as { type?: string }).type ?? (err as Error).name, orderId: order.id }, "stripe refund failed");
          throw providerError("stripe", "refund the payment");
        }
      } else {
        const refund = await razorpayApi.refund({ keyId: secrets.publicKey, keySecret: secrets.secretKey }, payment.providerPaymentId, prep.providerAmount, idempotencyKey);
        refundId = refund.id;
      }

      const out = await req.tenant(async (tx) => {
        const [current] = await tx.select().from(payments).where(eq(payments.id, payment.id)).limit(1);
        // A refund webhook may already have recorded it.
        const refundedCents = Math.min(payment.amountCents, Math.max(current!.refundedCents, payment.refundedCents + prep.amountCents));
        const full = refundedCents >= payment.amountCents;
        await tx.update(payments).set({ refundedCents, status: full ? "refunded" : "partially_refunded" }).where(eq(payments.id, payment.id));
        if (full) await tx.update(orders).set({ status: "refunded" }).where(eq(orders.id, order.id));
        let unenrolled = false;
        if (req.body.unenrol) {
          const [course] = await tx.select().from(courses).where(eq(courses.id, order.courseId)).limit(1);
          if (course) {
            await unenrolUser(tx, course, order.userId);
            unenrolled = true;
          }
        }
        await audit(tx, req, "payment.refunded", { type: "order", id: order.id }, {
          provider: order.provider,
          refundId,
          amountCents: prep.amountCents,
          currency: order.currency,
          totalRefundedCents: refundedCents,
          unenrolled,
          reason: req.body.reason ?? null,
        });
        return { status: full ? ("refunded" as const) : order.status, refundedCents, unenrolled };
      });
      if (out.unenrolled) await emit("user.unenrolled", { organizationId: req.org.id, courseId: order.courseId, userId: order.userId });
      return { status: out.status, refundedCents: out.refundedCents };
    },
  );

  // ─── Webhooks (raw body, organization from the path) ────────────────────

  await app.register(async (instance) => {
    const scope = instance.withTypeProvider<ZodTypeProvider>();
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: 512 * 1024 }, (_req, body, done) => done(null, body));

    const params = z.object({ organizationId: zId });
    const webhookConfig = { tenant: false, rateLimit: { max: 1000, timeWindow: "1 minute" } };

    scope.post(
      "/webhooks/stripe/:organizationId",
      {
        config: webhookConfig,
        schema: { tags: ["Payments"], summary: "Stripe webhook for an organization's course sales", params, response: { 200: zWebhookAck } },
      },
      async (req) => {
        const organizationId = req.params.organizationId;
        const raw = req.body;
        const signature = req.headers["stripe-signature"];
        if (!Buffer.isBuffer(raw) || typeof signature !== "string") throw badRequest("Invalid webhook request");
        const gateway = await withTenant(organizationId, (tx) => loadGateway(tx, "stripe"));
        const secret = gateway ? gatewaySecrets(gateway).webhookSecret : null;
        if (!secret) throw notFound("Webhook endpoint");
        let event: Stripe.Event;
        try {
          event = Stripe.webhooks.constructEvent(raw, signature, secret);
        } catch {
          req.log.warn({ organizationId }, "stripe webhook signature rejected");
          throw badRequest("Invalid signature");
        }
        const results = await withTenant(organizationId, async (tx) => {
          const fresh = await claimWebhookEvent(tx, { scope: webhookScope("stripe", organizationId), eventId: event.id, type: event.type });
          if (!fresh) return [];
          return handleStripeEvent(tx, organizationId, event);
        });
        for (const r of results) await emitFulfilment(r);
        return { received: true as const };
      },
    );

    scope.post(
      "/webhooks/razorpay/:organizationId",
      {
        config: webhookConfig,
        schema: { tags: ["Payments"], summary: "Razorpay webhook for an organization's course sales", params, response: { 200: zWebhookAck } },
      },
      async (req) => {
        const organizationId = req.params.organizationId;
        const raw = req.body;
        const signature = req.headers["x-razorpay-signature"];
        if (!Buffer.isBuffer(raw) || typeof signature !== "string") throw badRequest("Invalid webhook request");
        const gateway = await withTenant(organizationId, (tx) => loadGateway(tx, "razorpay"));
        const secret = gateway ? gatewaySecrets(gateway).webhookSecret : null;
        if (!secret) throw notFound("Webhook endpoint");
        if (!verifyRazorpayWebhookSignature(raw, signature, secret)) {
          req.log.warn({ organizationId }, "razorpay webhook signature rejected");
          throw badRequest("Invalid signature");
        }
        let body: RazorpayWebhook;
        try {
          body = JSON.parse(raw.toString("utf8")) as RazorpayWebhook;
        } catch {
          throw badRequest("Invalid JSON");
        }
        if (typeof body?.event !== "string") throw badRequest("Invalid event");
        const header = req.headers["x-razorpay-event-id"];
        const eventId = typeof header === "string" && header ? header : sha256(raw);
        const results = await withTenant(organizationId, async (tx) => {
          const fresh = await claimWebhookEvent(tx, { scope: webhookScope("razorpay", organizationId), eventId, type: body.event });
          if (!fresh) return [];
          return handleRazorpayEvent(tx, organizationId, body, eventId);
        });
        for (const r of results) await emitFulfilment(r);
        return { received: true as const };
      },
    );
  });
};
