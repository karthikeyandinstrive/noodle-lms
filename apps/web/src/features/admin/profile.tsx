"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, LogOut, Monitor, Smartphone } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ErrorAlert, PageHeader, QueryState, formatDate } from "@/components/common";
import { FileInput } from "@/components/file-input";
import type { Order } from "@/features/payments/types";
import { api, errorMessage, fileUrl } from "@/lib/api";
import { meKey } from "@/lib/session";
import { ConfirmDialog, Field, formatMoney } from "./shared";
import type { AdminUser } from "./types";

const profileKey = ["users", "me"] as const;
type Session = { id: string; current: boolean; ip: string | null; userAgent: string | null; createdAt: string; lastSeenAt: string };

function ProfileForm({ me }: { me: AdminUser }) {
  const qc = useQueryClient();
  const [v, setV] = useState(() => ({ firstName: me.firstName, lastName: me.lastName, bio: me.bio ?? "", avatarFileId: me.avatarFileId, locale: me.locale, timezone: me.timezone }));
  const [error, setError] = useState<unknown>(null);
  const timezones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  const save = useMutation({
    mutationFn: () => api<AdminUser>("/users/me", { method: "PATCH", body: { ...v, bio: v.bio.trim() || null } }),
    onSuccess: (u) => {
      toast.success("Profile saved");
      qc.setQueryData(profileKey, u);
      void qc.invalidateQueries({ queryKey: meKey });
    },
    onError: setError,
  });
  const initials = `${v.firstName[0] ?? ""}${v.lastName[0] ?? ""}`;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile</CardTitle>
        <CardDescription>{me.email}</CardDescription>
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
          <div className="flex flex-wrap items-center gap-4">
            <Avatar className="size-16">
              {v.avatarFileId && <AvatarImage src={fileUrl(v.avatarFileId, true)} alt="" />}
              <AvatarFallback className="text-lg">{initials}</AvatarFallback>
            </Avatar>
            <FileInput accept="image/png,image/jpeg,image/webp,image/gif" component="user" area="avatar" value={v.avatarFileId} onChange={(id) => setV({ ...v, avatarFileId: id })} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id="p-first" label="First name">
              <Input id="p-first" required maxLength={100} autoComplete="given-name" value={v.firstName} onChange={(e) => setV({ ...v, firstName: e.target.value })} />
            </Field>
            <Field id="p-last" label="Last name">
              <Input id="p-last" required maxLength={100} autoComplete="family-name" value={v.lastName} onChange={(e) => setV({ ...v, lastName: e.target.value })} />
            </Field>
          </div>
          <Field id="p-bio" label="About me">
            <Textarea id="p-bio" rows={3} maxLength={5000} value={v.bio} onChange={(e) => setV({ ...v, bio: e.target.value })} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id="p-locale" label="Language" hint="e.g. en, fr, es-MX">
              <Input id="p-locale" maxLength={10} value={v.locale} onChange={(e) => setV({ ...v, locale: e.target.value })} />
            </Field>
            <Field id="p-tz" label="Time zone">
              <Input id="p-tz" list="p-tz-list" maxLength={64} value={v.timezone} onChange={(e) => setV({ ...v, timezone: e.target.value })} />
              <datalist id="p-tz-list">
                {timezones.map((tz) => (
                  <option key={tz} value={tz} />
                ))}
              </datalist>
            </Field>
          </div>
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save profile"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function PasswordCard() {
  const qc = useQueryClient();
  const [v, setV] = useState({ currentPassword: "", newPassword: "", confirm: "" });
  const [error, setError] = useState<unknown>(null);
  const change = useMutation({
    mutationFn: () => {
      if (v.newPassword !== v.confirm) throw new Error("The new passwords don't match");
      return api("/auth/password/change", { body: { currentPassword: v.currentPassword, newPassword: v.newPassword } });
    },
    onSuccess: () => {
      toast.success("Password changed. Your other sessions were signed out.");
      setV({ currentPassword: "", newPassword: "", confirm: "" });
      void qc.invalidateQueries({ queryKey: ["auth", "sessions"] });
    },
    onError: setError,
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Change password</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            change.mutate();
          }}
        >
          {error ? <ErrorAlert error={error} /> : null}
          <Field id="pw-current" label="Current password">
            <Input id="pw-current" type="password" required autoComplete="current-password" value={v.currentPassword} onChange={(e) => setV({ ...v, currentPassword: e.target.value })} />
          </Field>
          <Field id="pw-new" label="New password" hint="At least 10 characters.">
            <Input id="pw-new" type="password" required minLength={10} maxLength={200} autoComplete="new-password" value={v.newPassword} onChange={(e) => setV({ ...v, newPassword: e.target.value })} />
          </Field>
          <Field id="pw-confirm" label="Confirm new password">
            <Input id="pw-confirm" type="password" required minLength={10} maxLength={200} autoComplete="new-password" value={v.confirm} onChange={(e) => setV({ ...v, confirm: e.target.value })} />
          </Field>
          <Button type="submit" disabled={change.isPending}>
            {change.isPending ? "Changing…" : "Change password"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function describeAgent(ua: string | null) {
  if (!ua) return { label: "Unknown device", mobile: false };
  const mobile = /Mobile|Android|iPhone|iPad/i.test(ua);
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) && !/iPhone|iPad/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : "";
  return { label: os ? `${browser} on ${os}` : browser, mobile };
}

function SessionsCard() {
  const qc = useQueryClient();
  const router = useRouter();
  const [confirmAll, setConfirmAll] = useState(false);
  const sessions = useQuery({ queryKey: ["auth", "sessions"], queryFn: () => api<Session[]>("/auth/sessions") });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/auth/sessions/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Session revoked");
      void qc.invalidateQueries({ queryKey: ["auth", "sessions"] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const logoutAll = useMutation({
    mutationFn: () => api("/auth/logout-all", { body: {} }),
    onSuccess: () => {
      qc.clear();
      router.replace("/login");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const list = [...(sessions.data ?? [])].sort((a, b) => Number(b.current) - Number(a.current) || b.lastSeenAt.localeCompare(a.lastSeenAt));
  return (
    <Card>
      <CardHeader>
        <CardTitle>Where you&apos;re signed in</CardTitle>
        <CardDescription>Revoke any session you don&apos;t recognize.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <QueryState query={sessions}>
          <ul className="divide-y rounded-lg border">
            {list.map((s) => {
              const agent = describeAgent(s.userAgent);
              const Icon = agent.mobile ? Smartphone : Monitor;
              return (
                <li key={s.id} className="flex items-center gap-3 p-3">
                  <Icon className="size-5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1 text-sm">
                    <div className="flex flex-wrap items-center gap-2 font-medium">
                      {agent.label} {s.current && <Badge variant="secondary">This device</Badge>}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {s.ip ?? "Unknown IP"} · active {formatDate(s.lastSeenAt)} · since {formatDate(s.createdAt, false)}
                    </div>
                  </div>
                  {!s.current && (
                    <Button variant="outline" size="sm" disabled={revoke.isPending} onClick={() => revoke.mutate(s.id)} aria-label={`Revoke session ${agent.label}`}>
                      Revoke
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </QueryState>
        <Button variant="outline" onClick={() => setConfirmAll(true)}>
          <LogOut /> Sign out everywhere
        </Button>
      </CardContent>
      <ConfirmDialog
        open={confirmAll}
        onOpenChange={setConfirmAll}
        title="Sign out everywhere?"
        description="Every session, including this one, will be signed out."
        confirmLabel="Sign out everywhere"
        destructive
        pending={logoutAll.isPending}
        onConfirm={() => logoutAll.mutate()}
      />
    </Card>
  );
}

function OrdersCard() {
  const orders = useQuery({
    queryKey: ["payments", "orders", "me"],
    // Hide abandoned checkouts (pending for more than a day).
    queryFn: async () => {
      const cutoff = Date.now() - 86_400_000;
      return (await api<Order[]>("/payments/orders/me")).filter((o) => o.status !== "pending" || new Date(o.createdAt).getTime() > cutoff);
    },
  });
  const paid = orders.data ?? [];
  if (!orders.isSuccess || paid.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Purchases</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {paid.map((o) => (
            <li key={o.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <div className="min-w-0">
                <Link href={`/courses/${o.course.id}`} className="block truncate font-medium hover:underline">
                  {o.course.fullname}
                </Link>
                <span className="text-xs text-muted-foreground">{formatDate(o.createdAt)}</span>
              </div>
              <div className="text-right">
                <div className="tabular-nums">{formatMoney(o.amountCents, o.currency)}</div>
                <Badge variant={o.status === "paid" ? "secondary" : "outline"} className="capitalize">
                  {o.status}
                </Badge>
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function DataCard() {
  const [busy, setBusy] = useState(false);
  const download = async () => {
    setBusy(true);
    try {
      const data = await api<Record<string, unknown>>("/users/me/export");
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `my-data-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Your data</CardTitle>
        <CardDescription>Download a copy of your profile, enrolments, grades, submissions and forum posts as JSON.</CardDescription>
      </CardHeader>
      <CardContent>
        <Button variant="outline" onClick={() => void download()} disabled={busy}>
          <Download /> {busy ? "Preparing…" : "Download my data"}
        </Button>
      </CardContent>
    </Card>
  );
}

export function ProfilePage() {
  const me = useQuery({ queryKey: profileKey, queryFn: () => api<AdminUser>("/users/me") });
  return (
    <div>
      <PageHeader title="Profile & security" />
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <QueryState query={me}>{me.data && <ProfileForm me={me.data} />}</QueryState>
          <OrdersCard />
          <DataCard />
        </div>
        <div className="space-y-4">
          <PasswordCard />
          <SessionsCard />
        </div>
      </div>
    </div>
  );
}
