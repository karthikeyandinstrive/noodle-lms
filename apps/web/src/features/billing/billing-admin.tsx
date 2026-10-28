"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ExternalLink, Info, Sparkles } from "lucide-react";
import { useEffect } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { PageHeader, QueryState, formatDate } from "@/components/common";
import { RequireCapability, useSearchParam } from "@/features/admin/shared";
import { api, errorMessage } from "@/lib/api";

type Limits = { users: number | null; courses: number | null };
type Plans = { configured: boolean; current: string; plans: { id: string; name: string; description: string; limits: Limits }[] };
type Subscription = {
  configured: boolean;
  plan: string;
  limits: Limits;
  usage: { users: number; courses: number };
  subscription: { plan: string; status: string; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean; hasBillingAccount: boolean } | null;
};

const subKey = ["billing", "subscription"] as const;

function UsageRow({ label, used, limit }: { label: string; used: number; limit: number | null }) {
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return (
    <div className="space-y-1.5">
      <div className="flex justify-between text-sm">
        <span>{label}</span>
        <span className="tabular-nums text-muted-foreground">
          {used} / {limit ?? "Unlimited"}
        </span>
      </div>
      {limit !== null && <Progress value={pct} aria-label={`${label} used: ${pct}%`} />}
    </div>
  );
}

const STATUS_TEXT: Record<string, string> = {
  active: "Active",
  trialing: "Trial",
  past_due: "Payment overdue",
  canceled: "Cancelled",
  unpaid: "Unpaid",
  incomplete: "Incomplete",
  incomplete_expired: "Expired",
  paused: "Paused",
  none: "No subscription",
};

/** POSTs to a billing endpoint that returns a Stripe URL, then navigates there. */
function useRedirectMutation(path: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ url: string }>(path, { body: {} }),
    onSuccess: (r) => window.location.assign(r.url),
    onError: (e) => {
      toast.error(errorMessage(e));
      void qc.invalidateQueries({ queryKey: subKey });
    },
  });
}

export function BillingAdmin() {
  const checkoutParam = useSearchParam("checkout");
  const plans = useQuery({ queryKey: ["billing", "plans"], queryFn: () => api<Plans>("/billing/plans") });
  const sub = useQuery({
    queryKey: subKey,
    queryFn: () => api<Subscription>("/billing/subscription"),
    // After returning from Stripe, the webhook may land a few seconds later.
    refetchInterval: (q) => (checkoutParam === "success" && q.state.data?.plan !== "pro" ? 3000 : false),
  });

  useEffect(() => {
    if (checkoutParam === "success") toast.success("Thanks! Your subscription is being activated.");
    if (checkoutParam === "cancelled") toast("Checkout cancelled. You have not been charged.");
  }, [checkoutParam]);

  const checkout = useRedirectMutation("/billing/checkout");
  const portal = useRedirectMutation("/billing/portal");

  const data = sub.data;
  const isPro = data?.plan === "pro";
  const status = data?.subscription?.status;

  return (
    <RequireCapability capability="billing:manage">
      <PageHeader title="Subscription" description="Your organization's plan, usage and billing." />
      <QueryState query={sub}>
        {data && (
          <div className="space-y-6">
            {!data.configured && (
              <Alert>
                <Info />
                <AlertTitle>Billing is not configured</AlertTitle>
                <AlertDescription>The platform operator hasn&apos;t enabled online billing. Contact them to change your plan.</AlertDescription>
              </Alert>
            )}
            {status === "past_due" && (
              <Alert variant="destructive">
                <Info />
                <AlertTitle>Payment overdue</AlertTitle>
                <AlertDescription>Update your payment method in the billing portal to keep Pro features.</AlertDescription>
              </Alert>
            )}
            <Card>
              <CardHeader>
                <CardTitle className="flex flex-wrap items-center gap-2">
                  Current plan: <span className="capitalize">{data.plan}</span>
                  {status && status !== "none" && <Badge variant={status === "active" ? "default" : "outline"}>{STATUS_TEXT[status] ?? status}</Badge>}
                </CardTitle>
                {data.subscription?.currentPeriodEnd && (
                  <CardDescription>
                    {data.subscription.cancelAtPeriodEnd ? "Ends" : "Renews"} on {formatDate(data.subscription.currentPeriodEnd, false)}
                  </CardDescription>
                )}
              </CardHeader>
              <CardContent className="max-w-md space-y-4">
                <UsageRow label="Users" used={data.usage.users} limit={data.limits.users} />
                <UsageRow label="Courses" used={data.usage.courses} limit={data.limits.courses} />
              </CardContent>
              {data.configured && (
                <CardFooter className="flex flex-wrap gap-2">
                  {!isPro && (
                    <Button onClick={() => checkout.mutate()} disabled={checkout.isPending}>
                      <Sparkles /> {checkout.isPending ? "Redirecting…" : "Upgrade to Pro"}
                    </Button>
                  )}
                  {data.subscription?.hasBillingAccount && (
                    <Button variant="outline" onClick={() => portal.mutate()} disabled={portal.isPending}>
                      <ExternalLink /> {portal.isPending ? "Opening…" : "Manage billing"}
                    </Button>
                  )}
                </CardFooter>
              )}
            </Card>

            <QueryState query={plans}>
              <div className="grid gap-4 sm:grid-cols-2">
                {plans.data?.plans.map((p) => (
                  <Card key={p.id} className={p.id === data.plan ? "ring-2 ring-primary" : undefined}>
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2">
                        {p.name} {p.id === data.plan && <Badge variant="secondary">Current</Badge>}
                      </CardTitle>
                      <CardDescription>{p.description}</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <ul className="space-y-1.5 text-sm">
                        <li className="flex items-center gap-2">
                          <Check className="size-4 text-primary" /> {p.limits.users === null ? "Unlimited users" : `Up to ${p.limits.users} users`}
                        </li>
                        <li className="flex items-center gap-2">
                          <Check className="size-4 text-primary" /> {p.limits.courses === null ? "Unlimited courses" : `Up to ${p.limits.courses} courses`}
                        </li>
                      </ul>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </QueryState>
          </div>
        )}
      </QueryState>
    </RequireCapability>
  );
}
