"use client";

import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Check, CheckCheck, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState, QueryState } from "@/components/common";
import { Pager } from "@/features/reports/charts";
import { api, errorMessage, type Paged } from "@/lib/api";
import { useFormat, useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  notificationsKey,
  type AppNotification,
  type NotificationPreference,
} from "./types";

export function useRecentNotifications(pageSize = 5) {
  return useQuery({
    queryKey: [
      ...notificationsKey,
      "list",
      { page: 1, unread: false, pageSize },
    ],
    queryFn: () =>
      api<Paged<AppNotification>>("/notifications", {
        query: { page: 1, pageSize },
      }),
  });
}

function useMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { ids: string[] } | { all: true }) =>
      api<{ updated: number }>("/notifications/read", { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: notificationsKey }),
    onError: (e) => toast.error(errorMessage(e)),
  });
}

export function NotificationItem({
  n,
  compact = false,
}: {
  n: AppNotification;
  compact?: boolean;
}) {
  const t = useT();
  const fmt = useFormat();
  const qc = useQueryClient();
  const markRead = useMarkRead();
  const remove = useMutation({
    mutationFn: () => api(`/notifications/${n.id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: notificationsKey }),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const unread = !n.readAt;
  const title = n.link ? (
    <Link
      href={n.link}
      className="rounded-sm hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      onClick={() => unread && markRead.mutate({ ids: [n.id] })}
    >
      {n.title}
    </Link>
  ) : (
    n.title
  );
  return (
    <li className={cn("flex gap-3 py-3", unread && "font-medium")}>
      <span
        className={cn(
          "mt-1.5 size-2 shrink-0 rounded-full",
          unread ? "bg-primary" : "bg-transparent",
        )}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm break-words">
          {title}
          {unread && (
            <span className="ml-1.5 inline-flex rounded bg-primary/10 px-1 align-middle text-[10px] font-semibold uppercase text-primary">
              {t("notifications.unread", "Unread")}
            </span>
          )}
        </p>
        {!compact && n.body && (
          <p className="mt-0.5 text-sm font-normal break-words whitespace-pre-line text-muted-foreground">
            {n.body}
          </p>
        )}
        <p className="mt-0.5 text-xs font-normal text-muted-foreground">
          {fmt.date(n.createdAt)}
        </p>
      </div>
      {!compact && (
        <div className="flex shrink-0 items-start gap-1">
          {unread && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("notifications.markReadItem", "Mark \"{title}\" as read", { title: n.title })}
              disabled={markRead.isPending}
              onClick={() => markRead.mutate({ ids: [n.id] })}
            >
              <Check aria-hidden />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("notifications.deleteItem", "Delete \"{title}\"", { title: n.title })}
            onClick={() => remove.mutate()}
            disabled={remove.isPending}
          >
            <Trash2 aria-hidden />
          </Button>
        </div>
      )}
    </li>
  );
}

function NotificationList() {
  const t = useT();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [page, setPage] = useState(1);
  const markRead = useMarkRead();
  const query = useQuery({
    queryKey: [
      ...notificationsKey,
      "list",
      { page, unread: unreadOnly, pageSize: 20 },
    ],
    queryFn: () =>
      api<Paged<AppNotification>>("/notifications", {
        query: { page, pageSize: 20, unread: unreadOnly ? "true" : undefined },
      }),
    placeholderData: keepPreviousData,
  });
  const pages = query.data
    ? Math.max(1, Math.ceil(query.data.total / query.data.pageSize))
    : 1;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm">
          <Switch
            checked={unreadOnly}
            onCheckedChange={(v) => {
              setUnreadOnly(v);
              setPage(1);
            }}
          />
          {t("notifications.unreadOnly", "Unread only")}
        </label>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            markRead.mutate(
              { all: true },
              {
                onSuccess: (r) =>
                  toast.success(
                    r.updated
                      ? t("notifications.markedRead", "Marked {count} as read", { count: r.updated })
                      : t("notifications.nothingToMark", "Nothing to mark"),
                  ),
              },
            )
          }
        >
          <CheckCheck aria-hidden /> {t("notifications.markAllRead", "Mark all as read")}
        </Button>
      </div>
      <QueryState query={query}>
        {query.data?.items.length ? (
          <Card className="py-0">
            <CardContent>
              <ul className="divide-y">
                {query.data.items.map((n) => (
                  <NotificationItem key={n.id} n={n} />
                ))}
              </ul>
            </CardContent>
          </Card>
        ) : (
          <EmptyState
            title={
              unreadOnly
                ? t("notifications.emptyUnread", "No unread notifications")
                : t("notifications.empty", "No notifications yet")
            }
            description={t("notifications.emptyHint", "Grades, announcements and other updates will appear here.")}
          />
        )}
      </QueryState>
      <Pager page={page} pages={pages} onPage={setPage} />
    </div>
  );
}

function Preferences() {
  const t = useT();
  const query = useQuery({
    queryKey: [...notificationsKey, "preferences"],
    queryFn: () => api<NotificationPreference[]>("/notifications/preferences"),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("notifications.prefs.title", "Delivery preferences")}</CardTitle>
        <CardDescription>
          {t("notifications.prefs.description", "Choose how you hear about each kind of update.")}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <QueryState query={query}>
          {query.data && (
            <PreferencesForm
              key={JSON.stringify(query.data)}
              saved={query.data}
            />
          )}
        </QueryState>
      </CardContent>
    </Card>
  );
}

function PreferencesForm({ saved }: { saved: NotificationPreference[] }) {
  const t = useT();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<NotificationPreference[]>(saved);
  const save = useMutation({
    mutationFn: () =>
      api<NotificationPreference[]>("/notifications/preferences", {
        method: "PUT",
        body: {
          preferences: draft.map(({ type, inApp, email }) => ({
            type,
            inApp,
            email,
          })),
        },
      }),
    onSuccess: (data) => {
      qc.setQueryData([...notificationsKey, "preferences"], data);
      toast.success(t("notifications.prefs.saved", "Preferences saved"));
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const set = (type: string, key: "inApp" | "email", value: boolean) =>
    setDraft((d) =>
      d.map((p) => (p.type === type ? { ...p, [key]: value } : p)),
    );
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <table className="w-full text-sm">
        <caption className="sr-only">{t("notifications.prefs.caption", "Notification delivery per type")}</caption>
        <thead className="text-left text-muted-foreground">
          <tr>
            <th scope="col" className="py-2 pr-3 font-medium">
              {t("notifications.prefs.notification", "Notification")}
            </th>
            <th scope="col" className="w-20 py-2 text-center font-medium">
              {t("notifications.prefs.inApp", "In app")}
            </th>
            <th scope="col" className="w-20 py-2 text-center font-medium">
              {t("common.email", "Email")}
            </th>
          </tr>
        </thead>
        <tbody>
          {draft.map((p) => (
            <tr key={p.type} className="border-t">
              <th scope="row" className="py-2.5 pr-3 text-left font-normal">
                {p.label}
              </th>
              <td className="py-2.5 text-center">
                <Switch
                  aria-label={t("notifications.prefs.inAppFor", "{type}: in app", { type: p.label })}
                  checked={p.inApp}
                  onCheckedChange={(v) => set(p.type, "inApp", v)}
                />
              </td>
              <td className="py-2.5 text-center">
                <Switch
                  aria-label={t("notifications.prefs.emailFor", "{type}: email", { type: p.label })}
                  checked={p.email}
                  onCheckedChange={(v) => set(p.type, "email", v)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-4 flex items-center gap-3">
        <Button type="submit" disabled={!dirty || save.isPending}>
          {t("notifications.prefs.save", "Save preferences")}
        </Button>
        {dirty && (
          <Badge variant="outline" role="status">
            {t("notifications.prefs.unsaved", "Unsaved changes")}
          </Badge>
        )}
      </div>
    </form>
  );
}

export function NotificationCenter() {
  const t = useT();
  return (
    <Tabs defaultValue="all">
      <TabsList>
        <TabsTrigger value="all">{t("notifications.tab.all", "Notifications")}</TabsTrigger>
        <TabsTrigger value="preferences">{t("notifications.tab.preferences", "Preferences")}</TabsTrigger>
      </TabsList>
      <TabsContent value="all" className="pt-4">
        <NotificationList />
      </TabsContent>
      <TabsContent value="preferences" className="pt-4">
        <Preferences />
      </TabsContent>
    </Tabs>
  );
}
