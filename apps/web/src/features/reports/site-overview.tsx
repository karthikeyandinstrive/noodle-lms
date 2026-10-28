"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, QueryState } from "@/components/common";
import { api } from "@/lib/api";
import { DailyBars, InlineBar, Stat } from "./charts";
import type { SiteReport } from "./types";

export function SiteOverview() {
  const query = useQuery({ queryKey: ["reports", "site"], queryFn: () => api<SiteReport>("/reports/site") });
  const d = query.data;
  const maxEnrol = Math.max(1, ...(d?.topCourses.map((c) => c.enrolments) ?? [0]));
  return (
    <QueryState query={query}>
      {d && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Users" value={d.users.toLocaleString()} hint={`${d.newUsers30d.toLocaleString()} new in 30 days`} />
            <Stat label="Active users" value={d.activeUsers7d.toLocaleString()} hint={`last 7 days · ${d.activeUsers30d.toLocaleString()} in 30 days`} />
            <Stat label="Courses" value={d.courses.toLocaleString()} hint={`${d.visibleCourses.toLocaleString()} visible`} />
            <Stat label="Active enrolments" value={d.enrolments.toLocaleString()} />
            <Stat label="Course completions" value={d.completions.toLocaleString()} hint={`${d.completions30d.toLocaleString()} in 30 days`} />
          </div>
          <Card>
            <CardContent>
              <DailyBars title="Active users per day (last 30 days)" data={d.activeUsersByDay} unit="users" />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Top courses by enrolment</CardTitle>
            </CardHeader>
            <CardContent>
              {d.topCourses.length ? (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[480px] text-sm">
                    <caption className="sr-only">Top courses by active enrolments, with completions</caption>
                    <thead className="text-left text-muted-foreground">
                      <tr>
                        <th scope="col" className="py-2 pr-3 font-medium">Course</th>
                        <th scope="col" className="w-2/5 py-2 pr-3 font-medium">Enrolments</th>
                        <th scope="col" className="py-2 pr-3 text-right font-medium">Completions</th>
                        <th scope="col" className="py-2 text-right font-medium">Rate</th>
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
                              <span className="w-10 text-right tabular-nums">{c.enrolments}</span>
                            </div>
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">{c.completions}</td>
                          <td className="py-2 text-right tabular-nums">{c.enrolments ? `${Math.round((c.completions / c.enrolments) * 100)}%` : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <EmptyState title="No enrolments yet" />
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </QueryState>
  );
}
