import { createHmac } from "node:crypto";
import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import {
  claimWebhookEvent,
  fromProviderAmount,
  paidAmountMatches,
  safeHexEqual,
  toProviderAmount,
  validateCharge,
  validateGatewayKeys,
  verifyRazorpayPaymentSignature,
  verifyRazorpayWebhookSignature,
  webhookScope,
} from "./lib";

const hmac = (secret: string, data: string | Buffer) => createHmac("sha256", secret).update(data).digest("hex");

describe("Razorpay payment signature", () => {
  const keySecret = "test_key_secret_123";
  const sig = hmac(keySecret, "order_ABC|pay_XYZ");

  it("accepts a valid signature", () => {
    expect(verifyRazorpayPaymentSignature({ razorpayOrderId: "order_ABC", razorpayPaymentId: "pay_XYZ", signature: sig, keySecret })).toBe(true);
  });
  it("accepts an upper-case hex signature", () => {
    expect(verifyRazorpayPaymentSignature({ razorpayOrderId: "order_ABC", razorpayPaymentId: "pay_XYZ", signature: sig.toUpperCase(), keySecret })).toBe(true);
  });
  it("rejects a signature for another order or payment", () => {
    expect(verifyRazorpayPaymentSignature({ razorpayOrderId: "order_OTHER", razorpayPaymentId: "pay_XYZ", signature: sig, keySecret })).toBe(false);
    expect(verifyRazorpayPaymentSignature({ razorpayOrderId: "order_ABC", razorpayPaymentId: "pay_OTHER", signature: sig, keySecret })).toBe(false);
  });
  it("rejects a wrong secret, truncated, non-hex and empty signatures", () => {
    expect(verifyRazorpayPaymentSignature({ razorpayOrderId: "order_ABC", razorpayPaymentId: "pay_XYZ", signature: sig, keySecret: "other" })).toBe(false);
    expect(verifyRazorpayPaymentSignature({ razorpayOrderId: "order_ABC", razorpayPaymentId: "pay_XYZ", signature: sig.slice(0, 40), keySecret })).toBe(false);
    expect(verifyRazorpayPaymentSignature({ razorpayOrderId: "order_ABC", razorpayPaymentId: "pay_XYZ", signature: "zz" + sig.slice(2), keySecret })).toBe(false);
    expect(verifyRazorpayPaymentSignature({ razorpayOrderId: "order_ABC", razorpayPaymentId: "pay_XYZ", signature: "", keySecret })).toBe(false);
    expect(verifyRazorpayPaymentSignature({ razorpayOrderId: "", razorpayPaymentId: "pay_XYZ", signature: hmac(keySecret, "|pay_XYZ"), keySecret })).toBe(false);
  });
});

describe("Razorpay webhook signature (raw body)", () => {
  const secret = "whsecret";
  const body = Buffer.from('{"event":"payment.captured","payload":{"payment":{"entity":{"id":"pay_1"}}}}');

  it("verifies against the exact raw bytes", () => {
    expect(verifyRazorpayWebhookSignature(body, hmac(secret, body), secret)).toBe(true);
  });
  it("fails if the body was re-serialized or altered", () => {
    const reserialized = Buffer.from(JSON.stringify(JSON.parse(body.toString()), null, 2));
    expect(verifyRazorpayWebhookSignature(reserialized, hmac(secret, body), secret)).toBe(false);
  });
  it("fails without a signature or secret", () => {
    expect(verifyRazorpayWebhookSignature(body, undefined, secret)).toBe(false);
    expect(verifyRazorpayWebhookSignature(body, hmac(secret, body), "")).toBe(false);
  });
  it("safeHexEqual rejects length mismatch without throwing", () => {
    expect(safeHexEqual("abcd", "abcdef")).toBe(false);
    expect(safeHexEqual("abcd", "abcd")).toBe(true);
  });
});

describe("Stripe webhook signature (raw body)", () => {
  it("constructEvent accepts the raw payload and rejects tampering", () => {
    const secret = "whsec_test123";
    const payload = JSON.stringify({ id: "evt_1", object: "event", type: "checkout.session.completed", data: { object: {} } });
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret });
    expect(Stripe.webhooks.constructEvent(Buffer.from(payload), header, secret).id).toBe("evt_1");
    expect(() => Stripe.webhooks.constructEvent(Buffer.from(payload.replace("evt_1", "evt_2")), header, secret)).toThrow();
  });
});

describe("amount and currency validation", () => {
  it("rejects free, missing and malformed prices", () => {
    expect(validateCharge(0, "USD", "stripe").ok).toBe(false);
    expect(validateCharge(null, "USD", "stripe").ok).toBe(false);
    expect(validateCharge(-100, "USD", "stripe").ok).toBe(false);
    expect(validateCharge(10.5, "USD", "stripe").ok).toBe(false);
    expect(validateCharge(1000, null, "stripe").ok).toBe(false);
    expect(validateCharge(1000, "US", "stripe").ok).toBe(false);
  });
  it("enforces provider minimums", () => {
    expect(validateCharge(49, "USD", "stripe").ok).toBe(false);
    expect(validateCharge(50, "USD", "stripe")).toEqual({ ok: true, amount: 50, currency: "USD" });
    expect(validateCharge(99, "INR", "razorpay").ok).toBe(false);
    expect(validateCharge(49900, "inr", "razorpay")).toEqual({ ok: true, amount: 49900, currency: "INR" });
  });
  it("converts zero- and three-decimal currencies", () => {
    expect(toProviderAmount(150000, "JPY")).toBe(1500);
    expect(validateCharge(150050, "JPY", "stripe").ok).toBe(false);
    expect(toProviderAmount(1234, "KWD")).toBe(12340);
    expect(fromProviderAmount(1500, "JPY")).toBe(150000);
    expect(fromProviderAmount(12340, "KWD")).toBe(1234);
    expect(fromProviderAmount(999, "EUR")).toBe(999);
  });
  it("rejects amounts above the provider maximum", () => {
    expect(validateCharge(100_000_000, "USD", "stripe").ok).toBe(false);
  });
  it("matches paid amounts against the order", () => {
    const order = { amountCents: 2500, currency: "USD" };
    expect(paidAmountMatches(order, { amount: 2500, currency: "usd" })).toBe(true);
    expect(paidAmountMatches(order, { amount: 2499, currency: "usd" })).toBe(false);
    expect(paidAmountMatches(order, { amount: 2500, currency: "eur" })).toBe(false);
    expect(paidAmountMatches(order, { amount: null, currency: "usd" })).toBe(false);
    expect(paidAmountMatches({ amountCents: 150000, currency: "JPY" }, { amount: 1500, currency: "jpy" })).toBe(true);
  });
});

describe("gateway key validation", () => {
  it("checks Stripe key prefixes against the mode", () => {
    expect(validateGatewayKeys({ provider: "stripe", publicKey: "pk_test_abc", secretKey: "sk_test_abc", webhookSecret: "whsec_abc", testMode: true })).toBeNull();
    expect(validateGatewayKeys({ provider: "stripe", publicKey: "pk_live_abc", secretKey: "sk_test_abc", testMode: true })).toMatch(/pk_test_/);
    expect(validateGatewayKeys({ provider: "stripe", publicKey: "pk_test_abc", secretKey: "pk_test_abc", testMode: true })).toMatch(/Secret key/);
    expect(validateGatewayKeys({ provider: "stripe", publicKey: "pk_test_abc", webhookSecret: "nope", testMode: true })).toMatch(/whsec_/);
  });
  it("checks Razorpay key ids", () => {
    expect(validateGatewayKeys({ provider: "razorpay", publicKey: "rzp_test_abc123", secretKey: "abcdefghij123", testMode: true })).toBeNull();
    expect(validateGatewayKeys({ provider: "razorpay", publicKey: "rzp_test_abc123", testMode: false })).toMatch(/rzp_live_/);
  });
});

describe("webhook idempotency", () => {
  /** Minimal fake of `tx.insert(table).values(v).onConflictDoNothing().returning()` with a unique (provider,eventId). */
  function fakeTx() {
    const seen = new Set<string>();
    const tx = {
      insert: () => ({
        values: (v: { provider: string; eventId: string }) => ({
          onConflictDoNothing: () => ({
            returning: async () => {
              const key = `${v.provider}\u0000${v.eventId}`;
              if (seen.has(key)) return [];
              seen.add(key);
              return [{ id: key }];
            },
          }),
        }),
      }),
    };
    return tx as unknown as Parameters<typeof claimWebhookEvent>[0];
  }

  it("processes an event once per endpoint scope", async () => {
    const tx = fakeTx();
    const a = webhookScope("stripe", "org-a");
    const b = webhookScope("stripe", "org-b");
    expect(await claimWebhookEvent(tx, { scope: a, eventId: "evt_1", type: "checkout.session.completed" })).toBe(true);
    expect(await claimWebhookEvent(tx, { scope: a, eventId: "evt_1", type: "checkout.session.completed" })).toBe(false);
    expect(await claimWebhookEvent(tx, { scope: b, eventId: "evt_1", type: "checkout.session.completed" })).toBe(true);
    expect(await claimWebhookEvent(tx, { scope: a, eventId: "evt_2", type: "charge.refunded" })).toBe(true);
  });
  it("requires an event id", async () => {
    await expect(claimWebhookEvent(fakeTx(), { scope: "stripe:x", eventId: "", type: "t" })).rejects.toThrow();
  });
});
