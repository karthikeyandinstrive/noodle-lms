"use client";

import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState, QueryState } from "@/components/common";
import { api } from "@/lib/api";
import { fmtGrade, fmtPercent, type MyCourseGrade } from "./types";
import { UserReportTable, useMyUserReport } from "./user-report";

function CourseDrilldown({ courseId }: { courseId: string }) {
  const report = useMyUserReport(courseId);
  return (
    <div className="border-t p-4">
      <QueryState query={report}>{report.data && <UserReportTable report={report.data} compact />}</QueryState>
      <Button variant="link" className="mt-2 px-0" render={<Link href={`/courses/${courseId}/grades`} />}>
        Open course grades and feedback
      </Button>
    </div>
  );
}

/** All my course totals, each expandable to the course's user report. */
export function MyGradesOverview() {
  const [open, setOpen] = useState<string | null>(null);
  const query = useQuery({ queryKey: ["grades", "me"], queryFn: () => api<MyCourseGrade[]>("/grades/me") });
  return (
    <QueryState query={query}>
      {query.data?.length ? (
        <ul className="space-y-3">
          {query.data.map((row) => {
            const expanded = open === row.course.id;
            const panelId = `grades-${row.course.id}`;
            return (
              <li key={row.course.id}>
                <Card className="gap-0 py-0">
                  <button
                    type="button"
                    className="flex w-full items-center gap-3 p-4 text-left hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    aria-expanded={expanded}
                    aria-controls={panelId}
                    onClick={() => setOpen(expanded ? null : row.course.id)}
                  >
                    {expanded ? <ChevronDown className="size-4 shrink-0" aria-hidden /> : <ChevronRight className="size-4 shrink-0" aria-hidden />}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{row.course.fullname}</span>
                      <span className="block text-xs text-muted-foreground">{row.course.shortname}</span>
                    </span>
                    <span className="text-right">
                      <span className="block text-lg font-semibold tabular-nums">{fmtPercent(row.percentage)}</span>
                      {row.gradeMax !== null && (
                        <span className="block text-xs text-muted-foreground tabular-nums">
                          {fmtGrade(row.grade)} / {fmtGrade(row.gradeMax)}
                        </span>
                      )}
                    </span>
                  </button>
                  <div id={panelId} hidden={!expanded}>
                    {expanded && <CourseDrilldown courseId={row.course.id} />}
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyState title="No grades yet" description="Your course totals appear here once you are enrolled in a course." />
      )}
    </QueryState>
  );
}
