/** Payments API shapes (mirror apps/api/src/modules/payments/routes.ts). */

export type PaymentProvider = "stripe" | "razorpay";
export type OrderStatus = "pending" | "paid" | "failed" | "refunded" | "cancelled";

export type Gateway = {
  provider: PaymentProvider;
  configured: boolean;
  enabled: boolean;
  testMode: boolean;
  publicKey: string | null;
  secretKey: string | null;
  webhookSecret: string | null;
  webhookUrl: string;
  updatedAt: string | null;
};

export type PublicGateway = { provider: PaymentProvider; publicKey: string; testMode: boolean };

export type Order = {
  id: string;
  status: OrderStatus;
  provider: PaymentProvider;
  amountCents: number;
  currency: string;
  refundedCents: number;
  providerRef: string | null;
  createdAt: string;
  updatedAt: string;
  course: { id: string; fullname: string };
};

export type AdminOrder = Order & {
  user: { id: string; firstName: string; lastName: string; email: string };
  providerPaymentId: string | null;
};

export type CheckoutResult =
  | { provider: "stripe"; orderId: string; url: string }
  | {
      provider: "razorpay";
      orderId: string;
      razorpay: {
        keyId: string;
        orderId: string;
        amount: number;
        currency: string;
        name: string;
        description: string;
        prefill: { name: string; email: string };
      };
    };

export const PROVIDER_LABEL: Record<PaymentProvider, string> = { stripe: "Stripe", razorpay: "Razorpay" };
