import { createHmac, timingSafeEqual } from "node:crypto";
import { webhookEvents, type DB } from "@lms/db";

/**
 * Pure helpers for the payments module (no config / network access) so they
 * can be unit-tested in isolation.
 */

export type Provider = "stripe" | "razorpay";

// ─── Signatures ─────────────────────────────────────────────────────────────

/** Constant-time comparison of two hex digests. Returns false on any length/format mismatch. */
export function safeHexEqual(expectedHex: string, actualHex: string): boolean {
  if (typeof actualHex !== "string" || !/^[0-9a-f]+$/i.test(actualHex)) return false;
  const a = Buffer.from(expectedHex, "hex");
  const b = Buffer.from(actualHex.toLowerCase(), "hex");
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

export function hmacSha256Hex(secret: string, payload: string | Buffer) {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/**
 * Razorpay Checkout success callback: signature = HMAC_SHA256(order_id + "|" + payment_id, key_secret).
 * `razorpayOrderId` must be the id stored on our order, never one supplied by the client.
 */
export function verifyRazorpayPaymentSignature(input: {
  razorpayOrderId: string;
  razorpayPaymentId: string;
  signature: string;
  keySecret: string;
}): boolean {
  if (!input.razorpayOrderId || !input.razorpayPaymentId || !input.signature || !input.keySecret) return false;
  const expected = hmacSha256Hex(input.keySecret, `${input.razorpayOrderId}|${input.razorpayPaymentId}`);
  return safeHexEqual(expected, input.signature);
}

/** Razorpay webhooks: X-Razorpay-Signature = HMAC_SHA256(raw request body, webhook_secret). */
export function verifyRazorpayWebhookSignature(rawBody: Buffer | string, signature: string | undefined, webhookSecret: string): boolean {
  if (!signature || !webhookSecret) return false;
  return safeHexEqual(hmacSha256Hex(webhookSecret, rawBody), signature);
}

// ─── Amounts & currencies ───────────────────────────────────────────────────

/** Currencies whose smallest unit is the major unit (Stripe "zero-decimal"). */
const ZERO_DECIMAL = new Set(["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]);
/** Currencies with three minor digits; providers expect amount × 1000 (last digit 0). */
const THREE_DECIMAL = new Set(["BHD", "JOD", "KWD", "OMR", "TND"]);

/** Approximate provider minimum charges, in our cents (amount × 100). Unlisted currencies only need > 0. */
const MINIMUM_CENTS: Record<Provider, Record<string, number>> = {
  stripe: { USD: 50, EUR: 50, GBP: 30, INR: 50, AUD: 50, CAD: 50, CHF: 50, SGD: 50, NZD: 50, JPY: 5000, HKD: 400, MXN: 1000, BRL: 50, DKK: 250, SEK: 300, NOK: 300 },
  razorpay: { INR: 100 },
};
/** Stripe's maximum amount is 99,999,999 in the smallest unit. */
const MAX_PROVIDER_AMOUNT = 99_999_999;

/**
 * Course prices are stored as `priceCents` = major units × 100 for every currency
 * (the web formats `priceCents / 100`). Converts to the provider's smallest unit.
 */
export function toProviderAmount(amountCents: number, currency: string): number {
  const c = currency.toUpperCase();
  if (ZERO_DECIMAL.has(c)) return amountCents / 100;
  if (THREE_DECIMAL.has(c)) return amountCents * 10;
  return amountCents;
}

export type ChargeCheck = { ok: true; amount: number; currency: string } | { ok: false; reason: string };

/** Validates a server-side (course row) amount + currency before charging. */
export function validateCharge(amountCents: number | null | undefined, currency: string | null | undefined, provider: Provider): ChargeCheck {
  if (amountCents === null || amountCents === undefined || !Number.isInteger(amountCents) || amountCents <= 0) {
    return { ok: false, reason: "This course is not for sale" };
  }
  if (!currency || !/^[A-Za-z]{3}$/.test(currency)) return { ok: false, reason: "This course has no valid currency" };
  const c = currency.toUpperCase();
  const amount = toProviderAmount(amountCents, c);
  if (!Number.isInteger(amount)) return { ok: false, reason: `${c} amounts must be whole units` };
  const min = MINIMUM_CENTS[provider][c] ?? 1;
  if (amountCents < min) return { ok: false, reason: `The price is below the ${provider} minimum for ${c}` };
  if (amount > MAX_PROVIDER_AMOUNT) return { ok: false, reason: "The price is above the provider maximum" };
  return { ok: true, amount, currency: c };
}

/** True when what the provider reports as paid equals what the order requires. */
export function paidAmountMatches(
  order: { amountCents: number; currency: string },
  paid: { amount: number | null | undefined; currency: string | null | undefined },
): boolean {
  if (paid.amount === null || paid.amount === undefined || !paid.currency) return false;
  return paid.currency.toUpperCase() === order.currency.toUpperCase() && paid.amount === toProviderAmount(order.amountCents, order.currency);
}

/** Converts a provider amount (smallest unit) back to our cents. */
export function fromProviderAmount(amount: number, currency: string): number {
  const c = currency.toUpperCase();
  if (ZERO_DECIMAL.has(c)) return amount * 100;
  if (THREE_DECIMAL.has(c)) return Math.round(amount / 10);
  return amount;
}

// ─── Keys ───────────────────────────────────────────────────────────────────

/** Sanity checks for gateway credentials (catches pasting the wrong key into the wrong field). */
export function validateGatewayKeys(input: {
  provider: Provider;
  publicKey: string;
  secretKey?: string;
  webhookSecret?: string;
  testMode: boolean;
}): string | null {
  if (input.provider === "stripe") {
    const mode = input.testMode ? "test" : "live";
    if (!new RegExp(`^pk_${mode}_[A-Za-z0-9]+$`).test(input.publicKey)) return `Publishable key must start with pk_${mode}_`;
    if (input.secretKey && !new RegExp(`^(sk|rk)_${mode}_[A-Za-z0-9]+$`).test(input.secretKey)) return `Secret key must start with sk_${mode}_ or rk_${mode}_`;
    if (input.webhookSecret && !/^whsec_[A-Za-z0-9+/=]+$/.test(input.webhookSecret)) return "Webhook signing secret must start with whsec_";
  } else {
    const mode = input.testMode ? "test" : "live";
    if (!new RegExp(`^rzp_${mode}_[A-Za-z0-9]+$`).test(input.publicKey)) return `Key id must start with rzp_${mode}_`;
    if (input.secretKey && !/^[A-Za-z0-9]{10,100}$/.test(input.secretKey)) return "Key secret looks invalid";
  }
  return null;
}

// ─── Webhook idempotency ────────────────────────────────────────────────────

/**
 * Namespaces webhook event ids per receiving endpoint. The same provider event can be
 * delivered to several endpoints (e.g. two organizations sharing a Stripe account),
 * and each must be processed independently.
 */
export function webhookScope(provider: Provider, scope: string) {
  return `${provider}:${scope}`;
}

type ClaimTx = Pick<DB, "insert">;

/**
 * Records a webhook event as processed. Returns false if it was already processed.
 * Call inside the same transaction as the side effects: if processing fails the
 * claim rolls back and the provider's retry is handled normally.
 */
export async function claimWebhookEvent(tx: ClaimTx, input: { scope: string; eventId: string; type: string }): Promise<boolean> {
  if (!input.eventId) throw new Error("Webhook event id is required");
  const rows = await tx
    .insert(webhookEvents)
    .values({ provider: input.scope, eventId: input.eventId.slice(0, 255), type: input.type.slice(0, 100) })
    .onConflictDoNothing()
    .returning({ id: webhookEvents.id });
  return rows.length > 0;
}
