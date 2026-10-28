"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, PlugZap, RotateCcw, Search, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState, ErrorAlert, PageHeader, QueryState, formatDate, fullName } from "@/components/common";
import { ConfirmDialog, Field, NativeSelect, Pager, RequireCapability, formatMoney, useDebounced } from "@/features/admin/shared";
import { api, errorMessage, type Paged } from "@/lib/api";
import { PROVIDER_LABEL, type AdminOrder, type Gateway, type OrderStatus, type PaymentProvider } from "./types";

const gatewaysKey = ["payments", "gateways"] as const;
const ordersKey = ["payments", "orders"] as const;

const HELP: Record<PaymentProvider, { publicLabel: string; publicPlaceholder: string; secretLabel: string; webhookLabel: string; webhookHint: string }> = {
  stripe: {
    publicLabel: "Publishable key",
    publicPlaceholder: "pk_test_…",
    secretLabel: "Secret key",
    webhookLabel: "Webhook signing secret",
    webhookHint: "Required. In Stripe → Developers → Webhooks, add the endpoint below with events checkout.session.completed, checkout.session.async_payment_succeeded, checkout.session.async_payment_failed, checkout.session.expired and charge.refunded.",
  },
  razorpay: {
    publicLabel: "Key ID",
    publicPlaceholder: "rzp_test_…",
    secretLabel: "Key secret",
    webhookLabel: "Webhook secret",
    webhookHint: "Recommended. In Razorpay → Settings → Webhooks, add the endpoint below with events payment.captured, order.paid and refund.processed.",
  },
};

function GatewayCard({ gateway }: { gateway: Gateway }) {
  const qc = useQueryClient();
  const help = HELP[gateway.provider];
  const init = () => ({ enabled: gateway.enabled, testMode: gateway.testMode, publicKey: gateway.publicKey ?? "", secretKey: "", webhookSecret: "", clearWebhook: false });
  const [v, setV] = useState(init);
  const [error, setError] = useState<unknown>(null);
  const [removing, setRemoving] = useState(false);

  const save = useMutation({
    mutationFn: () =>
      api<Gateway>(`/payments/gateways/${gateway.provider}`, {
        method: "PUT",
        body: {
          enabled: v.enabled,
          testMode: v.testMode,
          publicKey: v.publicKey.trim(),
          secretKey: v.secretKey.trim() || undefined,
          webhookSecret: v.clearWebhook ? null : v.webhookSecret.trim() || undefined,
        },
      }),
    onSuccess: () => {
      toast.success(`${PROVIDER_LABEL[gateway.provider]} settings saved`);
      void qc.invalidateQueries({ queryKey: ["payments"] });
    },
    onError: setError,
  });
  const test = useMutation({
    mutationFn: () => api<{ ok: boolean; message: string }>(`/payments/gateways/${gateway.provider}/test`, { body: {} }),
    onSuccess: (r) => (r.ok ? toast.success(r.message) : toast.error(r.message)),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: () => api(`/payments/gateways/${gateway.provider}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Gateway removed");
      setRemoving(false);
      void qc.invalidateQueries({ queryKey: ["payments"] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const id = (s: string) => `${gateway.provider}-${s}`;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle className="flex flex-wrap items-center gap-2">
            {PROVIDER_LABEL[gateway.provider]}
            {gateway.configured ? (
              gateway.enabled ? <Badge>Enabled</Badge> : <Badge variant="outline">Disabled</Badge>
            ) : (
              <Badge variant="outline">Not configured</Badge>
            )}
            {gateway.configured && gateway.testMode && <Badge variant="secondary">Test mode</Badge>}
          </CardTitle>
          {gateway.updatedAt && <CardDescription>Updated {formatDate(gateway.updatedAt)}</CardDescription>}
        </div>
        {gateway.configured && (
          <Button variant="ghost" size="icon-sm" aria-label={`Remove ${PROVIDER_LABEL[gateway.provider]} credentials`} onClick={() => setRemoving(true)}>
            <Trash2 />
          </Button>
        )}
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            save.mutate();
          }}
        >
          {error ? <ErrorAlert error={error} /> : null}
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={v.testMode} onCheckedChange={(testMode) => setV({ ...v, testMode })} /> Test mode (use test keys)
          </label>
          <Field id={id("public")} label={help.publicLabel}>
            <Input id={id("public")} required autoComplete="off" maxLength={200} placeholder={help.publicPlaceholder} value={v.publicKey} onChange={(e) => setV({ ...v, publicKey: e.target.value })} />
          </Field>
          <Field id={id("secret")} label={help.secretLabel} hint={gateway.secretKey ? `Stored: ${gateway.secretKey}. Leave blank to keep it.` : "Encrypted at rest and never shown again."}>
            <Input
              id={id("secret")}
              type="password"
              autoComplete="new-password"
              required={!gateway.configured}
              maxLength={300}
              placeholder={gateway.secretKey ?? ""}
              value={v.secretKey}
              onChange={(e) => setV({ ...v, secretKey: e.target.value })}
            />
          </Field>
          <Field id={id("webhook")} label={help.webhookLabel} hint={help.webhookHint}>
            <Input
              id={id("webhook")}
              type="password"
              autoComplete="new-password"
              maxLength={300}
              disabled={v.clearWebhook}
              placeholder={gateway.webhookSecret ?? (gateway.provider === "stripe" ? "whsec_…" : "")}
              value={v.webhookSecret}
              onChange={(e) => setV({ ...v, webhookSecret: e.target.value })}
            />
          </Field>
          {gateway.webhookSecret && (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input type="checkbox" checked={v.clearWebhook} onChange={(e) => setV({ ...v, clearWebhook: e.target.checked })} /> Remove the stored webhook secret
            </label>
          )}
          <div className="space-y-1.5">
            <span className="text-sm font-medium">Webhook endpoint</span>
            <div className="flex gap-1">
              <Input readOnly value={gateway.webhookUrl} aria-label={`${PROVIDER_LABEL[gateway.provider]} webhook URL`} className="font-mono text-xs" onFocus={(e) => e.target.select()} />
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="Copy webhook URL"
                onClick={() => navigator.clipboard.writeText(gateway.webhookUrl).then(() => toast.success("Copied"), () => toast.error("Copy failed"))}
              >
                <Copy />
              </Button>
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={v.enabled} onCheckedChange={(enabled) => setV({ ...v, enabled })} /> Offer at checkout
          </label>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? "Saving…" : "Save"}
            </Button>
            {gateway.configured && (
              <Button type="button" variant="outline" disabled={test.isPending} onClick={() => test.mutate()}>
                <PlugZap /> {test.isPending ? "Testing…" : "Test credentials"}
              </Button>
            )}
          </div>
        </form>
      </CardContent>
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={`Remove ${PROVIDER_LABEL[gateway.provider]}?`}
        description="Checkout with this provider stops immediately and webhooks for in-flight payments will be rejected. Existing orders are kept."
        confirmLabel="Remove"
        destructive
        pending={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </Card>
  );
}

const STATUS_VARIANT: Record<OrderStatus, "default" | "secondary" | "outline" | "destructive"> = {
  paid: "default",
  pending: "outline",
  refunded: "secondary",
  failed: "destructive",
  cancelled: "outline",
};

function RefundDialog({ order, onClose }: { order: AdminOrder; onClose: () => void }) {
  const qc = useQueryClient();
  const remaining = order.amountCents - order.refundedCents;
  const [amount, setAmount] = useState((remaining / 100).toFixed(2));
  const [unenrol, setUnenrol] = useState(true);
  const [reason, setReason] = useState("");
  const refund = useMutation({
    mutationFn: () => {
      const cents = Math.round(Number.parseFloat(amount) * 100);
      if (!Number.isFinite(cents) || cents <= 0 || cents > remaining) throw new Error(`Enter an amount up to ${formatMoney(remaining, order.currency)}`);
      return api<{ status: OrderStatus; refundedCents: number }>(`/payments/orders/${order.id}/refund`, {
        body: { amountCents: cents === remaining ? undefined : cents, unenrol, reason: reason.trim() || undefined },
      });
    },
    onSuccess: (r) => {
      toast.success(r.status === "refunded" ? "Order fully refunded" : `Refunded; ${formatMoney(r.refundedCents, order.currency)} refunded in total`);
      void qc.invalidateQueries({ queryKey: ordersKey });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Refund order"
      description={`${fullName(order.user)} · ${order.course.fullname} · paid ${formatMoney(order.amountCents, order.currency)} via ${PROVIDER_LABEL[order.provider]}. Refunds can't be undone.`}
      confirmLabel="Refund"
      destructive
      pending={refund.isPending}
      onConfirm={() => refund.mutate()}
    >
      <Field id="refund-amount" label={`Amount (${order.currency})`} hint={`Up to ${formatMoney(remaining, order.currency)}.`}>
        <Input id="refund-amount" type="number" inputMode="decimal" min="0.01" step="0.01" max={(remaining / 100).toFixed(2)} required value={amount} onChange={(e) => setAmount(e.target.value)} />
      </Field>
      <Field id="refund-reason" label="Internal note">
        <Input id="refund-reason" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={unenrol} onChange={(e) => setUnenrol(e.target.checked)} /> Unenrol the learner from the course
      </label>
    </ConfirmDialog>
  );
}

function OrdersTable() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"" | OrderStatus>("");
  const [provider, setProvider] = useState<"" | PaymentProvider>("");
  const [page, setPage] = useState(1);
  const [refunding, setRefunding] = useState<AdminOrder | null>(null);
  const q = useDebounced(search.trim());
  const orders = useQuery({
    queryKey: [...ordersKey, { q, status, provider, page }],
    queryFn: () => api<Paged<AdminOrder>>("/payments/orders", { query: { search: q, status, provider, page, pageSize: 25 } }),
    placeholderData: keepPreviousData,
  });
  return (
    <>
      <div className="mb-4 flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-8"
            type="search"
            placeholder="Buyer, course or provider reference"
            aria-label="Search orders"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <NativeSelect className="sm:w-40" aria-label="Filter by status" value={status} onChange={(e) => {
            setStatus(e.target.value as "" | OrderStatus);
            setPage(1);
          }}>
          <option value="">All statuses</option>
          {(["paid", "pending", "refunded", "failed", "cancelled"] as const).map((s) => (
            <option key={s} value={s} className="capitalize">
              {s}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect className="sm:w-36" aria-label="Filter by provider" value={provider} onChange={(e) => {
            setProvider(e.target.value as "" | PaymentProvider);
            setPage(1);
          }}>
          <option value="">All providers</option>
          <option value="stripe">Stripe</option>
          <option value="razorpay">Razorpay</option>
        </NativeSelect>
      </div>
      <QueryState query={orders}>
        {orders.data && orders.data.items.length === 0 ? (
          <EmptyState title="No orders" />
        ) : (
          orders.data && (
            <>
              <div className="overflow-x-auto rounded-xl border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Buyer</TableHead>
                      <TableHead className="hidden md:table-cell">Course</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>
                        <span className="sr-only">Actions</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {orders.data.items.map((o) => (
                      <TableRow key={o.id}>
                        <TableCell className="whitespace-nowrap text-muted-foreground">{formatDate(o.createdAt)}</TableCell>
                        <TableCell>
                          <div className="font-medium">{fullName(o.user)}</div>
                          <div className="max-w-48 truncate text-xs text-muted-foreground">{o.user.email}</div>
                          <div className="max-w-48 truncate text-xs text-muted-foreground md:hidden">{o.course.fullname}</div>
                        </TableCell>
                        <TableCell className="hidden max-w-56 truncate md:table-cell">{o.course.fullname}</TableCell>
                        <TableCell className="text-right whitespace-nowrap tabular-nums">
                          {formatMoney(o.amountCents, o.currency)}
                          {o.refundedCents > 0 && o.status !== "refunded" && (
                            <div className="text-xs text-muted-foreground">−{formatMoney(o.refundedCents, o.currency)} refunded</div>
                          )}
                          <div className="text-xs text-muted-foreground">{PROVIDER_LABEL[o.provider]}</div>
                        </TableCell>
                        <TableCell>
                          <Badge variant={STATUS_VARIANT[o.status]} className="capitalize">
                            {o.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          {o.status === "paid" && (
                            <Button variant="ghost" size="sm" onClick={() => setRefunding(o)} aria-label={`Refund order for ${fullName(o.user)}`}>
                              <RotateCcw /> <span className="hidden sm:inline">Refund</span>
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <Pager page={orders.data.page} pageSize={orders.data.pageSize} total={orders.data.total} onPage={setPage} />
            </>
          )
        )}
      </QueryState>
      {refunding && <RefundDialog key={refunding.id} order={refunding} onClose={() => setRefunding(null)} />}
    </>
  );
}

export function PaymentsAdmin() {
  const gateways = useQuery({ queryKey: gatewaysKey, queryFn: () => api<Gateway[]>("/payments/gateways") });
  return (
    <RequireCapability capability="payment:manage">
      <PageHeader title="Payments" description="Sell courses with Stripe or Razorpay. Set a price on a course in its settings." />
      <Tabs defaultValue="orders">
        <TabsList>
          <TabsTrigger value="orders">Orders</TabsTrigger>
          <TabsTrigger value="gateways">Gateways</TabsTrigger>
        </TabsList>
        <TabsContent value="orders" className="pt-2">
          <OrdersTable />
        </TabsContent>
        <TabsContent value="gateways" className="pt-2">
          <QueryState query={gateways}>
            <div className="grid gap-4 lg:grid-cols-2">
              {gateways.data?.map((g) => (
                <GatewayCard key={`${g.provider}:${g.updatedAt ?? "new"}`} gateway={g} />
              ))}
            </div>
          </QueryState>
        </TabsContent>
      </Tabs>
    </RequireCapability>
  );
}
