import { and, eq, inArray } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import Stripe from "stripe";
import { auditLogs, courses, orders, paymentGateways, payments, type DB } from "@lms/db";
import { config } from "../../config";
import { decryptSecret } from "../../core/crypto";
import { AppError, badRequest } from "../../core/errors";
import type { EventMap } from "../../core/events";
import { logger } from "../../core/logger";
import { notify } from "../../core/notify";
import { enrolUser } from "../courses/service";
import { fromProviderAmount, paidAmountMatches, type Provider } from "./lib";

export type GatewayRow = typeof paymentGateways.$inferSelect;
export type OrderRow = typeof orders.$inferSelect;

export type GatewaySecrets = { publicKey: string; secretKey: string; webhookSecret: string | null; testMode: boolean };

export async function loadGateway(tx: DB, provider: Provider) {
  const [row] = await tx.select().from(paymentGateways).where(eq(paymentGateways.provider, provider)).limit(1);
  return row ?? null;
}

export function gatewaySecrets(row: GatewayRow): GatewaySecrets {
  return {
    publicKey: row.publicKey,
    secretKey: decryptSecret(row.secretKeyEnc),
    webhookSecret: row.webhookSecretEnc ? decryptSecret(row.webhookSecretEnc) : null,
    testMode: row.testMode,
  };
}

/** Error for upstream provider failures. Never echoes raw provider messages (they can contain account details). */
export const providerError = (provider: Provider, action: string) =>
  new AppError(502, "PAYMENT_PROVIDER_ERROR", `The payment provider (${provider}) could not ${action}. Please try again later.`);

// ─── Stripe ─────────────────────────────────────────────────────────────────

export function stripeClient(secretKey: string) {
  return new Stripe(secretKey, { maxNetworkRetries: 2, timeout: 20_000, appInfo: { name: "lms" } });
}

// ─── Razorpay (plain REST, https://razorpay.com/docs/api/) ──────────────────

const RAZORPAY_API = "https://api.razorpay.com/v1";

export type RazorpayOrder = { id: string; amount: number; currency: string; status: string; receipt?: string };
export type RazorpayPayment = { id: string; order_id: string | null; amount: number; currency: string; status: string; amount_refunded?: number };
export type RazorpayRefund = { id: string; payment_id: string; amount: number; currency: string; status: string };

async function razorpay<T>(creds: { keyId: string; keySecret: string }, method: "GET" | "POST", path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Basic ${Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString("base64")}`,
    Accept: "application/json",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["X-Razorpay-Idempotency-Key"] = idempotencyKey;
  let res: Response;
  try {
    res = await fetch(`${RAZORPAY_API}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    logger.warn({ err: (err as Error).name, path }, "razorpay request failed");
    throw providerError("razorpay", "be reached");
  }
  const data = (await res.json().catch(() => null)) as (T & { error?: { code?: string; description?: string } }) | null;
  if (!res.ok || !data) {
    logger.warn({ status: res.status, code: data?.error?.code, path }, "razorpay API error");
    if (res.status === 401) throw badRequest("Razorpay rejected the credentials");
    throw providerError("razorpay", "process the request");
  }
  return data;
}

export const razorpayApi = {
  createOrder: (c: { keyId: string; keySecret: string }, input: { amount: number; currency: string; receipt: string; notes: Record<string, string> }) =>
    razorpay<RazorpayOrder>(c, "POST", "/orders", input),
  fetchPayment: (c: { keyId: string; keySecret: string }, paymentId: string) =>
    razorpay<RazorpayPayment>(c, "GET", `/payments/${encodeURIComponent(paymentId)}`),
  capture: (c: { keyId: string; keySecret: string }, paymentId: string, amount: number, currency: string) =>
    razorpay<RazorpayPayment>(c, "POST", `/payments/${encodeURIComponent(paymentId)}/capture`, { amount, currency }),
  refund: (c: { keyId: string; keySecret: string }, paymentId: string, amount: number, idempotencyKey: string) =>
    razorpay<RazorpayRefund>(c, "POST", `/payments/${encodeURIComponent(paymentId)}/refund`, { amount }, idempotencyKey),
  ping: (c: { keyId: string; keySecret: string }) => razorpay<unknown>(c, "GET", "/orders?count=1"),
};

// ─── Return URLs ────────────────────────────────────────────────────────────

/**
 * Base URL of the web app for redirects back from a provider. Uses the request's
 * Origin when it is this tenant's host (or an allowed origin), so SaaS tenants on
 * their own subdomain/custom domain return to the right place; otherwise APP_URL.
 */
export function appBaseUrl(req: FastifyRequest) {
  const origin = req.headers.origin;
  if (origin) {
    try {
      const url = new URL(origin);
      const allowed =
        config.allowedOrigins.includes(url.origin) ||
        url.host === req.host ||
        (config.SAAS_MODE && url.hostname.endsWith(`.${config.BASE_DOMAIN}`));
      if (allowed && (url.protocol === "https:" || !config.isProd)) return url.origin;
    } catch {
      /* fall through */
    }
  }
  return config.APP_URL.replace(/\/$/, "");
}

// ─── Fulfilment ─────────────────────────────────────────────────────────────

/** Audit entry for actions without a request organization (webhooks). */
export async function auditSystem(
  tx: DB,
  input: { organizationId: string; actorId?: string | null; action: string; target?: { type: string; id: string }; metadata?: Record<string, unknown> },
) {
  await tx.insert(auditLogs).values({
    organizationId: input.organizationId,
    actorId: input.actorId ?? null,
    action: input.action,
    targetType: input.target?.type ?? null,
    targetId: input.target?.id ?? null,
    metadata: input.metadata ?? {},
  });
}

export type FulfilResult = {
  payment: EventMap["payment.succeeded"];
  enrolled: EventMap["user.enrolled"] | null;
} | null;

/**
 * Marks an order paid, records the payment, enrols the buyer and notifies them.
 * Idempotent and race-safe: only the caller that flips the order to "paid" does the work.
 * The paid amount/currency must match the order (which was priced from the course row).
 * Emit the returned events AFTER the transaction commits.
 */
export async function fulfilOrder(
  tx: DB,
  input: {
    order: OrderRow;
    providerPaymentId: string;
    paidAmount: number | null | undefined;
    paidCurrency: string | null | undefined;
    source: "webhook" | "client_verify";
    raw?: Record<string, unknown>;
  },
): Promise<FulfilResult> {
  const { order } = input;
  if (order.status === "paid" || order.status === "refunded") return null;

  if (!paidAmountMatches(order, { amount: input.paidAmount, currency: input.paidCurrency })) {
    logger.error({ orderId: order.id, paidAmount: input.paidAmount, paidCurrency: input.paidCurrency }, "paid amount does not match order");
    await tx.update(orders).set({ status: "failed" }).where(and(eq(orders.id, order.id), eq(orders.status, "pending")));
    await auditSystem(tx, {
      organizationId: order.organizationId,
      action: "payment.amount_mismatch",
      target: { type: "order", id: order.id },
      metadata: { paidAmount: input.paidAmount ?? null, paidCurrency: input.paidCurrency ?? null, expectedCents: order.amountCents, currency: order.currency },
    });
    return null;
  }

  // Conditional update: concurrent webhook + client verification cannot both fulfil.
  const [flipped] = await tx
    .update(orders)
    .set({ status: "paid" })
    .where(and(eq(orders.id, order.id), inArray(orders.status, ["pending", "failed", "cancelled"])))
    .returning();
  if (!flipped) return null;

  await tx.insert(payments).values({
    organizationId: order.organizationId,
    orderId: order.id,
    provider: order.provider,
    providerPaymentId: input.providerPaymentId,
    amountCents: order.amountCents,
    currency: order.currency,
    status: "succeeded",
    raw: input.raw ?? null,
  });

  const [course] = await tx.select().from(courses).where(eq(courses.id, order.courseId)).limit(1);
  let created = false;
  if (course) {
    created = await enrolUser(tx, { organizationId: order.organizationId, course, userId: order.userId, method: "payment" });
    await notify(tx, {
      organizationId: order.organizationId,
      userIds: [order.userId],
      type: "payment",
      title: `Payment received: ${course.fullname}`,
      body: `Thank you for your purchase. You now have access to ${course.fullname}.`,
      link: `/courses/${course.id}`,
    });
  }
  await auditSystem(tx, {
    organizationId: order.organizationId,
    actorId: order.userId,
    action: "payment.succeeded",
    target: { type: "order", id: order.id },
    metadata: { provider: order.provider, amountCents: order.amountCents, currency: order.currency, courseId: order.courseId, source: input.source },
  });

  const base = { organizationId: order.organizationId, userId: order.userId, courseId: order.courseId };
  return { payment: { ...base, orderId: order.id }, enrolled: created ? base : null };
}

/** Records a refund reported by the provider (dashboard refunds, async refund webhooks). Idempotent. */
export async function recordProviderRefund(tx: DB, input: { provider: Provider; providerPaymentId: string; refundedAmount: number; currency: string }) {
  const [payment] = await tx
    .select()
    .from(payments)
    .where(and(eq(payments.provider, input.provider), eq(payments.providerPaymentId, input.providerPaymentId)))
    .limit(1);
  if (!payment) return;
  const refundedCents = Math.min(payment.amountCents, fromProviderAmount(input.refundedAmount, input.currency));
  if (refundedCents <= payment.refundedCents) return;
  const full = refundedCents >= payment.amountCents;
  await tx.update(payments).set({ refundedCents, status: full ? "refunded" : "partially_refunded" }).where(eq(payments.id, payment.id));
  if (full) await tx.update(orders).set({ status: "refunded" }).where(eq(orders.id, payment.orderId));
  await auditSystem(tx, {
    organizationId: payment.organizationId,
    action: "payment.refund_recorded",
    target: { type: "order", id: payment.orderId },
    metadata: { refundedCents, source: "webhook" },
  });
}

export async function findOrderByProviderRef(tx: DB, provider: Provider, providerRef: string) {
  const [order] = await tx
    .select()
    .from(orders)
    .where(and(eq(orders.provider, provider), eq(orders.providerRef, providerRef)))
    .limit(1);
  return order ?? null;
}

export async function findOrder(tx: DB, orderId: string) {
  const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  return order ?? null;
}

/** Marks a still-pending order as failed/cancelled (expired checkout, failed async payment). */
export async function closePendingOrder(tx: DB, orderId: string, status: "failed" | "cancelled") {
  await tx.update(orders).set({ status }).where(and(eq(orders.id, orderId), eq(orders.status, "pending")));
}
