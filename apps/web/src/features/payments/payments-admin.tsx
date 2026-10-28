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
import { EmptyState, ErrorAlert, PageHeader, QueryState, fullName } from "@/components/common";
import { ConfirmDialog, Field, NativeSelect, Pager, RequireCapability, useDebounced } from "@/features/admin/shared";
import { api, errorMessage, type Paged } from "@/lib/api";
import { useFormat, useT } from "@/lib/i18n";
import { PROVIDER_LABEL, useMoney, type AdminOrder, type Gateway, type OrderStatus, type PaymentProvider } from "./types";

const gatewaysKey = ["payments", "gateways"] as const;
const ordersKey = ["payments", "orders"] as const;

type Text = { key: string; text: string };
const HELP: Record<PaymentProvider, { publicLabel: Text; publicPlaceholder: string; secretLabel: Text; webhookLabel: Text; webhookHint: Text }> = {
  stripe: {
    publicLabel: { key: "payments.gateway.stripe.publicLabel", text: "Publishable key" },
    publicPlaceholder: "pk_test_…",
    secretLabel: { key: "payments.gateway.stripe.secretLabel", text: "Secret key" },
    webhookLabel: { key: "payments.gateway.stripe.webhookLabel", text: "Webhook signing secret" },
    webhookHint: {
      key: "payments.gateway.stripe.webhookHint",
      text: "Required. In Stripe → Developers → Webhooks, add the endpoint below with events checkout.session.completed, checkout.session.async_payment_succeeded, checkout.session.async_payment_failed, checkout.session.expired and charge.refunded.",
    },
  },
  razorpay: {
    publicLabel: { key: "payments.gateway.razorpay.publicLabel", text: "Key ID" },
    publicPlaceholder: "rzp_test_…",
    secretLabel: { key: "payments.gateway.razorpay.secretLabel", text: "Key secret" },
    webhookLabel: { key: "payments.gateway.razorpay.webhookLabel", text: "Webhook secret" },
    webhookHint: {
      key: "payments.gateway.razorpay.webhookHint",
      text: "Recommended. In Razorpay → Settings → Webhooks, add the endpoint below with events payment.captured, order.paid and refund.processed.",
    },
  },
};

function GatewayCard({ gateway }: { gateway: Gateway }) {
  const t = useT();
  const fmt = useFormat();
  const tx = (x: Text) => t(x.key, x.text);
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
      toast.success(t("payments.gateway.saved", "{provider} settings saved", { provider: PROVIDER_LABEL[gateway.provider] }));
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
      toast.success(t("payments.gateway.removed", "Gateway removed"));
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
              gateway.enabled ? <Badge>{t("payments.gateway.enabled", "Enabled")}</Badge> : <Badge variant="outline">{t("payments.gateway.disabled", "Disabled")}</Badge>
            ) : (
              <Badge variant="outline">{t("payments.gateway.notConfigured", "Not configured")}</Badge>
            )}
            {gateway.configured && gateway.testMode && <Badge variant="secondary">{t("payments.testMode", "Test mode")}</Badge>}
          </CardTitle>
          {gateway.updatedAt && <CardDescription>{t("payments.gateway.updated", "Updated {date}", { date: fmt.date(gateway.updatedAt) })}</CardDescription>}
        </div>
        {gateway.configured && (
          <Button variant="ghost" size="icon-sm" aria-label={t("payments.gateway.removeCredentials", "Remove {provider} credentials", { provider: PROVIDER_LABEL[gateway.provider] })} onClick={() => setRemoving(true)}>
            <Trash2 aria-hidden />
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
            <Switch checked={v.testMode} onCheckedChange={(testMode) => setV({ ...v, testMode })} /> {t("payments.gateway.testModeLabel", "Test mode (use test keys)")}
          </label>
          <Field id={id("public")} label={tx(help.publicLabel)}>
            <Input id={id("public")} required autoComplete="off" maxLength={200} placeholder={help.publicPlaceholder} value={v.publicKey} onChange={(e) => setV({ ...v, publicKey: e.target.value })} />
          </Field>
          <Field id={id("secret")} label={tx(help.secretLabel)}
            hint={
              gateway.secretKey
                ? t("payments.gateway.storedSecret", "Stored: {secret}. Leave blank to keep it.", { secret: gateway.secretKey })
                : t("payments.gateway.encrypted", "Encrypted at rest and never shown again.")
            }>
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
          <Field id={id("webhook")} label={tx(help.webhookLabel)} hint={tx(help.webhookHint)}>
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
              <input type="checkbox" checked={v.clearWebhook} onChange={(e) => setV({ ...v, clearWebhook: e.target.checked })} /> {t("payments.gateway.removeWebhook", "Remove the stored webhook secret")}
            </label>
          )}
          <div className="space-y-1.5">
            <span className="text-sm font-medium">{t("payments.gateway.webhookEndpoint", "Webhook endpoint")}</span>
            <div className="flex gap-1">
              <Input readOnly value={gateway.webhookUrl} aria-label={t("payments.gateway.webhookUrl", "{provider} webhook URL", { provider: PROVIDER_LABEL[gateway.provider] })} className="font-mono text-xs" onFocus={(e) => e.target.select()} />
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label={t("payments.gateway.copyWebhook", "Copy webhook URL")}
                onClick={() => navigator.clipboard.writeText(gateway.webhookUrl).then(() => toast.success(t("payments.gateway.copied", "Copied")), () => toast.error(t("payments.gateway.copyFailed", "Copy failed")))}
              >
                <Copy aria-hidden />
              </Button>
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={v.enabled} onCheckedChange={(enabled) => setV({ ...v, enabled })} /> {t("payments.gateway.offerAtCheckout", "Offer at checkout")}
          </label>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? t("common.saving", "Saving…") : t("common.save", "Save")}
            </Button>
            {gateway.configured && (
              <Button type="button" variant="outline" disabled={test.isPending} onClick={() => test.mutate()}>
                <PlugZap aria-hidden /> {test.isPending ? t("payments.gateway.testing", "Testing…") : t("payments.gateway.test", "Test credentials")}
              </Button>
            )}
          </div>
        </form>
      </CardContent>
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={t("payments.gateway.removeTitle", "Remove {provider}?", { provider: PROVIDER_LABEL[gateway.provider] })}
        description={t("payments.gateway.removeDescription", "Checkout with this provider stops immediately and webhooks for in-flight payments will be rejected. Existing orders are kept.")}
        confirmLabel={t("common.remove", "Remove")}
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

const STATUS_LABEL: Record<OrderStatus, string> = { paid: "Paid", pending: "Pending", refunded: "Refunded", failed: "Failed", cancelled: "Cancelled" };

function RefundDialog({ order, onClose }: { order: AdminOrder; onClose: () => void }) {
  const t = useT();
  const money = useMoney();
  const qc = useQueryClient();
  const remaining = order.amountCents - order.refundedCents;
  const [amount, setAmount] = useState((remaining / 100).toFixed(2));
  const [unenrol, setUnenrol] = useState(true);
  const [reason, setReason] = useState("");
  const refund = useMutation({
    mutationFn: () => {
      const cents = Math.round(Number.parseFloat(amount) * 100);
      if (!Number.isFinite(cents) || cents <= 0 || cents > remaining) throw new Error(t("payments.refund.amountError", "Enter an amount up to {amount}", { amount: money(remaining, order.currency) }));
      return api<{ status: OrderStatus; refundedCents: number }>(`/payments/orders/${order.id}/refund`, {
        body: { amountCents: cents === remaining ? undefined : cents, unenrol, reason: reason.trim() || undefined },
      });
    },
    onSuccess: (r) => {
      toast.success(
        r.status === "refunded"
          ? t("payments.refund.full", "Order fully refunded")
          : t("payments.refund.partial", "Refunded; {amount} refunded in total", { amount: money(r.refundedCents, order.currency) }),
      );
      void qc.invalidateQueries({ queryKey: ordersKey });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("payments.refund.title", "Refund order")}
      description={t("payments.refund.description", "{buyer} · {course} · paid {amount} via {provider}. Refunds can't be undone.", {
        buyer: fullName(order.user),
        course: order.course.fullname,
        amount: money(order.amountCents, order.currency),
        provider: PROVIDER_LABEL[order.provider],
      })}
      confirmLabel={t("payments.refund.confirm", "Refund")}
      destructive
      pending={refund.isPending}
      onConfirm={() => refund.mutate()}
    >
      <Field id="refund-amount" label={t("payments.refund.amount", "Amount ({currency})", { currency: order.currency })} hint={t("payments.refund.upTo", "Up to {amount}.", { amount: money(remaining, order.currency) })}>
        <Input id="refund-amount" type="number" inputMode="decimal" min="0.01" step="0.01" max={(remaining / 100).toFixed(2)} required value={amount} onChange={(e) => setAmount(e.target.value)} />
      </Field>
      <Field id="refund-reason" label={t("payments.refund.note", "Internal note")}>
        <Input id="refund-reason" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={unenrol} onChange={(e) => setUnenrol(e.target.checked)} /> {t("payments.refund.unenrol", "Unenrol the learner from the course")}
      </label>
    </ConfirmDialog>
  );
}

function OrdersTable() {
  const t = useT();
  const fmt = useFormat();
  const money = useMoney();
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
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-8"
            type="search"
            placeholder={t("payments.orders.searchPlaceholder", "Buyer, course or provider reference")}
            aria-label={t("payments.orders.search", "Search orders")}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <NativeSelect className="sm:w-40" aria-label={t("payments.orders.filterStatus", "Filter by status")} value={status} onChange={(e) => {
            setStatus(e.target.value as "" | OrderStatus);
            setPage(1);
          }}>
          <option value="">{t("payments.orders.allStatuses", "All statuses")}</option>
          {(["paid", "pending", "refunded", "failed", "cancelled"] as const).map((s) => (
            <option key={s} value={s}>
              {t(`payments.status.${s}`, STATUS_LABEL[s])}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect className="sm:w-36" aria-label={t("payments.orders.filterProvider", "Filter by provider")} value={provider} onChange={(e) => {
            setProvider(e.target.value as "" | PaymentProvider);
            setPage(1);
          }}>
          <option value="">{t("payments.orders.allProviders", "All providers")}</option>
          <option value="stripe">Stripe</option>
          <option value="razorpay">Razorpay</option>
        </NativeSelect>
      </div>
      <QueryState query={orders}>
        {orders.data && orders.data.items.length === 0 ? (
          <EmptyState title={t("payments.orders.empty", "No orders")} />
        ) : (
          orders.data && (
            <>
              <div className="overflow-x-auto rounded-xl border">
                <Table aria-label={t("payments.orders.tableLabel", "Orders")}>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("common.date", "Date")}</TableHead>
                      <TableHead>{t("payments.orders.buyer", "Buyer")}</TableHead>
                      <TableHead className="hidden md:table-cell">{t("payments.orders.course", "Course")}</TableHead>
                      <TableHead className="text-right">{t("payments.orders.amount", "Amount")}</TableHead>
                      <TableHead>{t("common.status", "Status")}</TableHead>
                      <TableHead>
                        <span className="sr-only">{t("common.actions", "Actions")}</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {orders.data.items.map((o) => (
                      <TableRow key={o.id}>
                        <TableCell className="whitespace-nowrap text-muted-foreground">{fmt.date(o.createdAt)}</TableCell>
                        <TableCell>
                          <div className="font-medium">{fullName(o.user)}</div>
                          <div className="max-w-48 truncate text-xs text-muted-foreground">{o.user.email}</div>
                          <div className="max-w-48 truncate text-xs text-muted-foreground md:hidden">{o.course.fullname}</div>
                        </TableCell>
                        <TableCell className="hidden max-w-56 truncate md:table-cell">{o.course.fullname}</TableCell>
                        <TableCell className="text-right whitespace-nowrap tabular-nums">
                          {money(o.amountCents, o.currency)}
                          {o.refundedCents > 0 && o.status !== "refunded" && (
                            <div className="text-xs text-muted-foreground">{t("payments.orders.refunded", "−{amount} refunded", { amount: money(o.refundedCents, o.currency) })}</div>
                          )}
                          <div className="text-xs text-muted-foreground">{PROVIDER_LABEL[o.provider]}</div>
                        </TableCell>
                        <TableCell>
                          <Badge variant={STATUS_VARIANT[o.status]}>{t(`payments.status.${o.status}`, STATUS_LABEL[o.status])}</Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          {o.status === "paid" && (
                            <Button variant="ghost" size="sm" onClick={() => setRefunding(o)} aria-label={t("payments.orders.refundFor", "Refund order for {name}", { name: fullName(o.user) })}>
                              <RotateCcw aria-hidden /> <span className="hidden sm:inline">{t("payments.refund.confirm", "Refund")}</span>
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
  const t = useT();
  const gateways = useQuery({ queryKey: gatewaysKey, queryFn: () => api<Gateway[]>("/payments/gateways") });
  return (
    <RequireCapability capability="payment:manage">
      <PageHeader title={t("payments.title", "Payments")} description={t("payments.description", "Sell courses with Stripe or Razorpay. Set a price on a course in its settings.")} />
      <Tabs defaultValue="orders">
        <TabsList>
          <TabsTrigger value="orders">{t("payments.tab.orders", "Orders")}</TabsTrigger>
          <TabsTrigger value="gateways">{t("payments.tab.gateways", "Gateways")}</TabsTrigger>
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
