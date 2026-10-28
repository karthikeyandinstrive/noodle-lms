import { boolean, index, integer, jsonb, pgEnum, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, orgId, ts, updatedAt } from "./_common";
import { organizations, users } from "./core";
import { courses } from "./courses";

export const paymentProvider = pgEnum("payment_provider", ["stripe", "razorpay"]);

/** Per-organization gateway credentials for selling courses. Secrets are encrypted. */
export const paymentGateways = pgTable(
  "payment_gateways",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    provider: paymentProvider().notNull(),
    enabled: boolean().notNull().default(false),
    publicKey: text().notNull(),
    secretKeyEnc: text().notNull(),
    webhookSecretEnc: text(),
    testMode: boolean().notNull().default(true),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("payment_gateways_uq").on(t.organizationId, t.provider)],
);

export const orderStatus = pgEnum("order_status", ["pending", "paid", "failed", "refunded", "cancelled"]);

/** A learner buying access to a course. */
export const orders = pgTable(
  "orders",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    courseId: uuid()
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    amountCents: integer().notNull(),
    currency: text().notNull(),
    status: orderStatus().notNull().default("pending"),
    provider: paymentProvider().notNull(),
    /** Stripe Checkout Session id / Razorpay order id. */
    providerRef: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("orders_user_idx").on(t.userId), uniqueIndex("orders_provider_ref_uq").on(t.provider, t.providerRef)],
);

export const payments = pgTable("payments", {
  id: id(),
  organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
  orderId: uuid()
    .notNull()
    .references(() => orders.id, { onDelete: "cascade" }),
  provider: paymentProvider().notNull(),
  providerPaymentId: text().notNull(),
  amountCents: integer().notNull(),
  currency: text().notNull(),
  status: text().notNull(),
  refundedCents: integer().notNull().default(0),
  raw: jsonb(),
  createdAt: createdAt(),
});

/** Idempotency: each provider webhook event is processed once. Not tenant-scoped. */
export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: id(),
    provider: text().notNull(),
    eventId: text().notNull(),
    type: text().notNull(),
    processedAt: ts().notNull().defaultNow(),
  },
  (t) => [uniqueIndex("webhook_events_uq").on(t.provider, t.eventId)],
);

// ─── SaaS billing (organization pays the platform) ──────────────────────────

export const subscriptions = pgTable("subscriptions", {
  id: id(),
  organizationId: orgId()
    .unique()
    .references(() => organizations.id, { onDelete: "cascade" }),
  plan: text().notNull(),
  status: text().notNull(),
  stripeCustomerId: text(),
  stripeSubscriptionId: text().unique(),
  currentPeriodEnd: ts(),
  cancelAtPeriodEnd: boolean().notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
