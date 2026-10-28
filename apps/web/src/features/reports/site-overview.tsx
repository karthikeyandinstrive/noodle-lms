"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, QueryState } from "@/components/common";
import { api } from "@/lib/api";
import { useFormat, useT } from "@/lib/i18n";
import { DailyBars, InlineBar, Stat } from "./charts";
import type { SiteReport } from "./types";

export function SiteOverview() {
  const t = useT();
  const { number: n } = useFormat();
  const query = useQuery({ queryKey: ["reports", "site"], queryFn: () => api<SiteReport>("/reports/site") });
  const d = query.data;
  const maxEnrol = Math.max(1, ...(d?.topCourses.map((c) => c.enrolments) ?? [0]));
  return (
    <QueryState query={query}>
      {d && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label={t("reports.users", "Users")} value={n(d.users)} hint={t("reports.newIn30Days", "{count} new in 30 days", { count: n(d.newUsers30d) })} />
            <Stat
              label={t("reports.activeUsers", "Active users")}
              value={n(d.activeUsers7d)}
              hint={t("reports.activeUsersHint", "last 7 days · {count} in 30 days", { count: n(d.activeUsers30d) })}
            />
            <Stat label={t("reports.courses", "Courses")} value={n(d.courses)} hint={t("reports.visibleCount", "{count} visible", { count: n(d.visibleCourses) })} />
            <Stat label={t("reports.activeEnrolments", "Active enrolments")} value={n(d.enrolments)} />
            <Stat label={t("reports.courseCompletions", "Course completions")} value={n(d.completions)} hint={t("reports.in30Days", "{count} in 30 days", { count: n(d.completions30d) })} />
          </div>
          <Card>
            <CardContent>
              <DailyBars title={t("reports.activeUsersPerDay", "Active users per day (last 30 days)")} data={d.activeUsersByDay} unit={t("reports.unitUsers", "users")} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t("reports.topCourses", "Top courses by enrolment")}</CardTitle>
            </CardHeader>
            <CardContent>
              {d.topCourses.length ? (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[480px] text-sm">
                    <caption className="sr-only">{t("reports.topCoursesCaption", "Top courses by active enrolments, with completions")}</caption>
                    <thead className="text-left text-muted-foreground">
                      <tr>
                        <th scope="col" className="py-2 pr-3 font-medium">{t("reports.course", "Course")}</th>
                        <th scope="col" className="w-2/5 py-2 pr-3 font-medium">{t("reports.enrolments", "Enrolments")}</th>
                        <th scope="col" className="py-2 pr-3 text-right font-medium">{t("reports.completions", "Completions")}</th>
                        <th scope="col" className="py-2 text-right font-medium">{t("reports.rate", "Rate")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.topCourses.map((c) => (
                        <tr key={c.id} className="border-t">
                          <th scope="row" className="py-2 pr-3 text-left font-normal">
                            <Link href={`/courses/${c.id}`} className="font-medium hover:underline">
                              {c.fullname}
                            </Link>
                            <div className="text-xs text-muted-foreground">{c.shortname}</div>
                          </th>
                          <td className="py-2 pr-3">
                            <div className="flex items-center gap-2">
                              <InlineBar value={c.enrolments} max={maxEnrol} />
                              <span className="w-10 text-right tabular-nums">{n(c.enrolments)}</span>
                            </div>
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">{n(c.completions)}</td>
                          <td className="py-2 text-right tabular-nums">{c.enrolments ? n(c.completions / c.enrolments, { style: "percent", maximumFractionDigits: 0 }) : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <EmptyState title={t("reports.noEnrolments", "No enrolments yet")} />
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </QueryState>
  );
}
