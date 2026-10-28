"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowRight, CalendarClock } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, QueryState } from "@/components/common";
import { CourseProgress } from "@/features/completion/progress-bar";
import { useProgressMap } from "@/features/completion/use-progress";
import { TYPE_LABELS, TYPE_STYLES, calendarKey, type CalendarItem } from "@/features/calendar/types";
import { CourseCard } from "@/features/courses/course-list";
import { NotificationItem, useRecentNotifications } from "@/features/notifications/notification-center";
import { api, type Paged } from "@/lib/api";
import { useSession } from "@/lib/session";
import type { Course } from "@/lib/types";
import { cn } from "@/lib/utils";

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

function relativeDay(d: Date) {
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(d) - startOf(new Date())) / 86_400_000);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (days === 0) return `Today, ${time}`;
  if (days === 1) return `Tomorrow, ${time}`;
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) + `, ${time}`;
}

function MyCourses() {
  const query = useQuery({
    queryKey: ["courses", { mine: true, search: "", page: 1, dashboard: true }],
    queryFn: () => api<Paged<Course>>("/courses", { query: { mine: true, page: 1, pageSize: 6 } }),
  });
  const progress = useProgressMap(query.data?.items.map((c) => c.id) ?? []);
  return (
    <section aria-labelledby="dash-courses" className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 id="dash-courses" className="text-lg font-semibold">
          My courses
        </h2>
        {!!query.data?.total && query.data.total > query.data.items.length && (
          <Button variant="link" size="sm" render={<Link href="/courses?mine=1" />}>
            All courses <ArrowRight />
          </Button>
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
          <EmptyState title="You're not enrolled in any courses yet" action={<Button render={<Link href="/catalog" />}>Browse the catalog</Button>} />
        )}
      </QueryState>
    </section>
  );
}

function Upcoming() {
  const query = useQuery({ queryKey: [...calendarKey, "upcoming"], queryFn: () => api<CalendarItem[]>("/calendar/upcoming", { query: { limit: 8 } }) });
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-base">
          <CalendarClock className="size-4" aria-hidden /> Upcoming
        </CardTitle>
        <Button variant="link" size="sm" render={<Link href="/calendar" />}>
          Calendar
        </Button>
      </CardHeader>
      <CardContent>
        <QueryState query={query}>
          {query.data?.length ? (
            <ul className="divide-y">
              {query.data.map((e) => (
                <li key={e.id} className="py-2.5">
                  <div className="flex items-start gap-2">
                    <span className={cn("mt-0.5 shrink-0 rounded px-1 text-[11px]", TYPE_STYLES[e.type])}>{TYPE_LABELS[e.type]}</span>
                    <div className="min-w-0">
                      {e.link ? (
                        <Link href={e.link} className="block truncate text-sm font-medium hover:underline">
                          {e.name}
                        </Link>
                      ) : (
                        <p className="truncate text-sm font-medium">{e.name}</p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        {relativeDay(new Date(e.startsAt))}
                        {e.courseName && ` · ${e.courseName}`}
                      </p>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">Nothing due in the next two weeks.</p>
          )}
        </QueryState>
      </CardContent>
    </Card>
  );
}

function RecentNotifications() {
  const query = useRecentNotifications(5);
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">Recent notifications</CardTitle>
        <Button variant="link" size="sm" render={<Link href="/notifications" />}>
          View all
        </Button>
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
            <p className="text-sm text-muted-foreground">You&apos;re all caught up.</p>
          )}
        </QueryState>
      </CardContent>
    </Card>
  );
}

export default function DashboardPage() {
  const { user } = useSession();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {greeting()}
          {user ? `, ${user.firstName}` : ""}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">Here&apos;s what&apos;s happening in your courses.</p>
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <MyCourses />
        <aside className="space-y-6" aria-label="Upcoming and notifications">
          <Upcoming />
          <RecentNotifications />
        </aside>
      </div>
    </div>
  );
}
