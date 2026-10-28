"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CreditCard, Lock } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, ErrorAlert, HtmlContent, QueryState } from "@/components/common";
import { formatMoney } from "@/features/admin/shared";
import { courseKey, useCourse } from "@/features/courses/use-course";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { PROVIDER_LABEL, type CheckoutResult, type PaymentProvider, type PublicGateway } from "./types";

// ─── Razorpay Checkout widget ─────────────────────────────────────────────────

type RazorpayResponse = { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string };
type RazorpayOptions = {
  key: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  order_id: string;
  prefill: { name: string; email: string };
  handler: (response: RazorpayResponse) => void;
  modal: { ondismiss: () => void };
  theme?: { color?: string };
};
type RazorpayInstance = { open: () => void; on: (event: "payment.failed", cb: (r: { error?: { description?: string } }) => void) => void };
declare global {
  interface Window {
    Razorpay?: new (options: RazorpayOptions) => RazorpayInstance;
  }
}

const RAZORPAY_SRC = "https://checkout.razorpay.com/v1/checkout.js";
let razorpayLoader: Promise<void> | null = null;

/** Loads Razorpay's checkout.js once, on demand. */
function loadRazorpay(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  razorpayLoader ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = RAZORPAY_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      razorpayLoader = null;
      script.remove();
      reject(new Error("Could not load the Razorpay checkout. Check your connection or disable blockers and try again."));
    };
    document.body.appendChild(script);
  });
  return razorpayLoader;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function CheckoutView() {
  const course = useCourse();
  const qc = useQueryClient();
  const router = useRouter();
  const gateways = useQuery({ queryKey: ["payments", "gateways", "public"], queryFn: () => api<PublicGateway[]>("/payments/gateways/public") });
  const [chosen, setProvider] = useState<PaymentProvider | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const provider = chosen && gateways.data?.some((g) => g.provider === chosen) ? chosen : (gateways.data?.[0]?.provider ?? null);

  const verify = useMutation({
    mutationFn: (body: { orderId: string; razorpay_payment_id: string; razorpay_signature: string }) =>
      api<{ status: string; courseId: string }>("/payments/razorpay/verify", { body }),
  });

  const data = course.data;
  if (!data) return null;
  const c = data.course;

  const finish = async () => {
    toast.success("Payment received. Welcome to the course!");
    await qc.invalidateQueries({ queryKey: courseKey(c.id) });
    void qc.invalidateQueries({ queryKey: ["courses"] });
    router.replace(`/courses/${c.id}`);
  };

  const pay = async () => {
    if (!provider) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<CheckoutResult>("/payments/checkout", { body: { courseId: c.id, provider } });
      if (result.provider === "stripe") {
        // Leave busy=true: the browser navigates to Stripe.
        window.location.assign(result.url);
        return;
      }
      await loadRazorpay();
      if (!window.Razorpay) throw new Error("Razorpay checkout is unavailable");
      const r = result.razorpay;
      const widget = new window.Razorpay({
        key: r.keyId,
        amount: r.amount,
        currency: r.currency,
        name: r.name,
        description: r.description,
        order_id: r.orderId,
        prefill: r.prefill,
        handler: (response) => {
          verify.mutate(
            { orderId: result.orderId, razorpay_payment_id: response.razorpay_payment_id, razorpay_signature: response.razorpay_signature },
            {
              onSuccess: () => void finish(),
              onError: (e) => {
                setError(e);
                setBusy(false);
              },
            },
          );
        },
        modal: { ondismiss: () => setBusy(false) },
      });
      widget.on("payment.failed", (resp) => toast.error(resp.error?.description ?? "The payment failed. You can try again."));
      widget.open();
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  if (data.enrolled) {
    return (
      <EmptyState
        title="You're already enrolled"
        description="You have access to this course."
        action={<Button render={<Link href={`/courses/${c.id}`} />}>Go to course</Button>}
      />
    );
  }
  if (!c.priceCents || !c.currency) {
    return <EmptyState title="This course is not for sale" action={<Button variant="outline" render={<Link href={`/courses/${c.id}`} />}>Back to course</Button>} />;
  }

  const price = formatMoney(c.priceCents, c.currency);
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <Button variant="ghost" size="sm" className="-ml-2" render={<Link href={`/courses/${c.id}`} />}>
        <ArrowLeft /> Back to course
      </Button>
      <Card>
        <CardHeader>
          <CardTitle>Checkout</CardTitle>
          <CardDescription>Lifetime access to {c.fullname}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-baseline justify-between gap-4 rounded-lg border bg-muted/30 p-3">
            <span className="min-w-0 truncate font-medium">{c.fullname}</span>
            <span className="text-lg font-semibold tabular-nums">{price}</span>
          </div>
          <HtmlContent html={c.summary} className="line-clamp-4 text-muted-foreground" />
          <QueryState query={gateways}>
            {gateways.data?.length === 0 ? (
              <Alert>
                <CreditCard />
                <AlertTitle>Payments are not available</AlertTitle>
                <AlertDescription>Online payment hasn&apos;t been set up yet. Please contact the administrator.</AlertDescription>
              </Alert>
            ) : (
              <fieldset className="space-y-2">
                <legend className="mb-2 text-sm font-medium">Pay with</legend>
                {gateways.data?.map((g) => (
                  <label
                    key={g.provider}
                    className={cn(
                      "flex cursor-pointer items-center justify-between gap-3 rounded-lg border p-3 text-sm has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50",
                      provider === g.provider && "border-primary bg-primary/5",
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <input type="radio" name="provider" value={g.provider} checked={provider === g.provider} onChange={() => setProvider(g.provider)} />
                      <span className="font-medium">{PROVIDER_LABEL[g.provider]}</span>
                      <span className="text-muted-foreground">{g.provider === "stripe" ? "Card, wallets" : "UPI, cards, netbanking"}</span>
                    </span>
                    {g.testMode && <Badge variant="outline">Test mode</Badge>}
                  </label>
                ))}
              </fieldset>
            )}
          </QueryState>
          {error ? <ErrorAlert error={error} title="Payment not completed" /> : null}
          {verify.isPending && <p className="text-sm text-muted-foreground" aria-live="polite">Confirming your payment…</p>}
        </CardContent>
        <CardFooter className="flex-col items-stretch gap-2">
          <Button size="lg" disabled={!provider || busy || !gateways.data?.length} onClick={() => void pay()}>
            {busy ? "Processing…" : `Pay ${price}`}
          </Button>
          <p className="flex items-center justify-center gap-1 text-xs text-muted-foreground">
            <Lock className="size-3" /> Payments are processed securely by {provider ? PROVIDER_LABEL[provider] : "our payment provider"}.
          </p>
        </CardFooter>
      </Card>
    </div>
  );
}
