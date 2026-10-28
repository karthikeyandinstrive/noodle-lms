"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowRight, CalendarClock } from "lucide-react";
import Link from "next/link";
import { useSyncExternalStore } from "react";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, QueryState } from "@/components/common";
import { CourseProgress } from "@/features/completion/progress-bar";
import { useProgressMap } from "@/features/completion/use-progress";
import { TYPE_STYLES, calendarKey, typeLabel, type CalendarItem } from "@/features/calendar/types";
import { CourseCard } from "@/features/courses/course-list";
import { NotificationItem, useRecentNotifications } from "@/features/notifications/notification-center";
import { api, type Paged } from "@/lib/api";
import { type Translate, useLocale, useT } from "@/lib/i18n";
import { useSession } from "@/lib/session";
import type { Course } from "@/lib/types";
import { cn } from "@/lib/utils";

type DayPart = "morning" | "afternoon" | "evening";

const dayPart = (): DayPart => {
  const h = new Date().getHours();
  return h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
};
const noSubscribe = () => () => {};

/** Time-of-day greeting. The server has no local clock, so it renders a neutral greeting and the client fills in the part of day after hydration. */
function Greeting({ name }: { name: string | undefined }) {
  const t = useT();
  const part = useSyncExternalStore(noSubscribe, dayPart, () => null);
  if (!part) return name ? t("dashboard.greeting.welcomeNamed", "Welcome, {name}", { name }) : t("dashboard.greeting.welcome", "Welcome");
  const fallback = { morning: "Good morning", afternoon: "Good afternoon", evening: "Good evening" }[part];
  return name ? t(`dashboard.greeting.${part}Named`, `${fallback}, {name}`, { name }) : t(`dashboard.greeting.${part}`, fallback);
}

function relativeDay(d: Date, t: Translate, locale: string) {
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(d) - startOf(new Date())) / 86_400_000);
  const time = d.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  if (days === 0) return t("dashboard.todayAt", "Today, {time}", { time });
  if (days === 1) return t("dashboard.tomorrowAt", "Tomorrow, {time}", { time });
  return `${d.toLocaleDateString(locale, { weekday: "short", month: "short", day: "numeric" })}, ${time}`;
}

function MyCourses() {
  const t = useT();
  const query = useQuery({
    queryKey: ["courses", { mine: true, search: "", page: 1, dashboard: true }],
    queryFn: () => api<Paged<Course>>("/courses", { query: { mine: true, page: 1, pageSize: 6 } }),
  });
  const progress = useProgressMap(query.data?.items.map((c) => c.id) ?? []);
  return (
    <section aria-labelledby="dash-courses" className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 id="dash-courses" className="text-lg font-semibold">
          {t("nav.myCourses", "My courses")}
        </h2>
        {!!query.data?.total && query.data.total > query.data.items.length && (
          <Link href="/courses?mine=1" className={buttonVariants({ variant: "link", size: "sm" })}>
            {t("dashboard.allCourses", "All courses")} <ArrowRight aria-hidden />
          </Link>
        )}
      </div>
      <QueryState query={query}>
        {query.data?.items.length ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {query.data.items.map((c) => (
              <div key={c.id} className="flex flex-col gap-2">
                <CourseCard course={c} />
                <div className="px-1">
                  <CourseProgress progress={progress.get(c.id)} />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            title={t("dashboard.notEnrolled", "You're not enrolled in any courses yet")}
            action={
              <Link href="/catalog" className={buttonVariants()}>
                {t("dashboard.browseCatalog", "Browse the catalog")}
              </Link>
            }
          />
        )}
      </QueryState>
    </section>
  );
}

function Upcoming() {
  const t = useT();
  const locale = useLocale();
  const query = useQuery({ queryKey: [...calendarKey, "upcoming"], queryFn: () => api<CalendarItem[]>("/calendar/upcoming", { query: { limit: 8 } }) });
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-base">
          <CalendarClock className="size-4" aria-hidden /> {t("dashboard.upcoming", "Upcoming")}
        </CardTitle>
        <Link href="/calendar" className={buttonVariants({ variant: "link", size: "sm" })}>
          {t("nav.calendar", "Calendar")}
        </Link>
      </CardHeader>
      <CardContent>
        <QueryState query={query}>
          {query.data?.length ? (
            <ul className="divide-y">
              {query.data.map((e) => (
                <li key={e.id} className="py-2.5">
                  <div className="flex items-start gap-2">
                    <span className={cn("mt-0.5 shrink-0 rounded px-1 text-[11px]", TYPE_STYLES[e.type])}>{typeLabel(t, e.type)}</span>
                    <div className="min-w-0">
                      {e.link ? (
                        <Link href={e.link} className="block truncate text-sm font-medium hover:underline">
                          {e.name}
                        </Link>
                      ) : (
                        <p className="truncate text-sm font-medium">{e.name}</p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        {relativeDay(new Date(e.startsAt), t, locale)}
                        {e.courseName && ` · ${e.courseName}`}
                      </p>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{t("dashboard.nothingDue", "Nothing due in the next two weeks.")}</p>
          )}
        </QueryState>
      </CardContent>
    </Card>
  );
}

function RecentNotifications() {
  const t = useT();
  const query = useRecentNotifications(5);
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">{t("dashboard.recentNotifications", "Recent notifications")}</CardTitle>
        <Link href="/notifications" className={buttonVariants({ variant: "link", size: "sm" })}>
          {t("dashboard.viewAll", "View all")}
        </Link>
      </CardHeader>
      <CardContent>
        <QueryState query={query}>
          {query.data?.items.length ? (
            <ul className="divide-y">
              {query.data.items.map((n) => (
                <NotificationItem key={n.id} n={n} compact />
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{t("dashboard.allCaughtUp", "You're all caught up.")}</p>
          )}
        </QueryState>
      </CardContent>
    </Card>
  );
}

export default function DashboardPage() {
  const { user } = useSession();
  const t = useT();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          <Greeting name={user?.firstName} />
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("dashboard.subtitle", "Here's what's happening in your courses.")}</p>
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <MyCourses />
        <aside className="space-y-6" aria-label={t("dashboard.asideLabel", "Upcoming and notifications")}>
          <Upcoming />
          <RecentNotifications />
        </aside>
      </div>
    </div>
  );
}
