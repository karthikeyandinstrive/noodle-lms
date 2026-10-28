"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState, QueryState, formatDate, fullName } from "@/components/common";
import { STATE_LABELS, type CompletionState } from "@/features/completion/types";
import { NativeSelect } from "@/features/gradebook/native-select";
import { fmtGrade } from "@/features/gradebook/types";
import { api } from "@/lib/api";
import { DailyBars, InlineBar, Pager, Stat } from "./charts";
import type { CourseOverviewReport, LogPage, OutlineReport, ParticipationReport } from "./types";

const completionLabel = (c: string | null) => (c ? (STATE_LABELS[c as CompletionState] ?? c) : "—");

function Overview({ courseId }: { courseId: string }) {
  const query = useQuery({
    queryKey: ["reports", courseId, "overview"],
    queryFn: () => api<CourseOverviewReport>(`/reports/courses/${courseId}/overview`),
  });
  const d = query.data;
  const maxViews = Math.max(1, ...(d?.activities.map((a) => a.views) ?? [0]));
  return (
    <QueryState query={query}>
      {d && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Learners" value={d.learners} />
            <Stat label="Course completions" value={d.completions} />
            <Stat label="Activity views (30 days)" value={d.views30d} />
            <Stat label="Active today" value={d.activeUsersByDay.at(-1)?.value ?? 0} />
          </div>
          <Card>
            <CardContent>
              <DailyBars title="Active users per day (last 30 days)" data={d.activeUsersByDay} unit="users" />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Activity views</CardTitle>
            </CardHeader>
            <CardContent>
              {d.activities.length ? (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[480px] text-sm">
                    <caption className="sr-only">Views and completions per activity</caption>
                    <thead className="text-left text-muted-foreground">
                      <tr>
                        <th scope="col" className="py-2 pr-3 font-medium">Activity</th>
                        <th scope="col" className="w-2/5 py-2 pr-3 font-medium">Views</th>
                        <th scope="col" className="py-2 pr-3 text-right font-medium">Viewers</th>
                        <th scope="col" className="py-2 text-right font-medium">Completed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.activities.map((a) => (
                        <tr key={a.id} className="border-t">
                          <th scope="row" className="py-2 pr-3 text-left font-normal">
                            <Link href={`/activities/${a.id}`} className="hover:underline">
                              {a.name}
                            </Link>
                          </th>
                          <td className="py-2 pr-3">
                            <div className="flex items-center gap-2">
                              <InlineBar value={a.views} max={maxViews} />
                              <span className="w-10 text-right tabular-nums">{a.views}</span>
                            </div>
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">{a.viewers}</td>
                          <td className="py-2 text-right tabular-nums">{a.completed}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <EmptyState title="No activities yet" />
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </QueryState>
  );
}

function OutlineDialog({ courseId, user, onClose }: { courseId: string; user: { id: string; firstName: string; lastName: string } | null; onClose: () => void }) {
  const query = useQuery({
    queryKey: ["reports", courseId, "outline", user?.id],
    queryFn: () => api<OutlineReport>(`/reports/courses/${courseId}/users/${user!.id}/outline`),
    enabled: !!user,
  });
  if (!user) return null;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Outline: {fullName(user)}</DialogTitle>
          <DialogDescription>Views, completion and grade per activity.</DialogDescription>
        </DialogHeader>
        <QueryState query={query}>
          {query.data && (
            <div className="max-h-[60vh] overflow-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-muted-foreground">
                  <tr>
                    <th scope="col" className="py-1.5 pr-2 font-medium">Activity</th>
                    <th scope="col" className="py-1.5 pr-2 text-right font-medium">Views</th>
                    <th scope="col" className="py-1.5 pr-2 font-medium">Last viewed</th>
                    <th scope="col" className="py-1.5 pr-2 font-medium">Completion</th>
                    <th scope="col" className="py-1.5 text-right font-medium">Grade</th>
                  </tr>
                </thead>
                <tbody>
                  {query.data.activities.map((a) => (
                    <tr key={a.id} className="border-t">
                      <th scope="row" className="py-1.5 pr-2 text-left font-normal">{a.name}</th>
                      <td className="py-1.5 pr-2 text-right tabular-nums">{a.views}</td>
                      <td className="py-1.5 pr-2 whitespace-nowrap">{formatDate(a.lastViewedAt)}</td>
                      <td className="py-1.5 pr-2">{completionLabel(a.completion)}</td>
                      <td className="py-1.5 text-right tabular-nums">{a.gradeMax !== null ? `${fmtGrade(a.grade)} / ${fmtGrade(a.gradeMax)}` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </QueryState>
      </DialogContent>
    </Dialog>
  );
}

function Participation({ courseId }: { courseId: string }) {
  const [activityId, setActivityId] = useState<string>("");
  const [page, setPage] = useState(1);
  const [outlineUser, setOutlineUser] = useState<ParticipationReport["items"][number]["user"] | null>(null);
  const query = useQuery({
    queryKey: ["reports", courseId, "participation", { activityId, page }],
    queryFn: () => api<ParticipationReport>(`/reports/courses/${courseId}/participation`, { query: { activityId: activityId || undefined, page, pageSize: 25 } }),
    placeholderData: keepPreviousData,
  });
  const d = query.data;
  const pages = d ? Math.max(1, Math.ceil(d.total / d.pageSize)) : 1;
  return (
    <div className="space-y-4">
      {d && d.activities.length > 0 && (
        <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
          <Label htmlFor="participation-activity">Activity</Label>
          <NativeSelect
            id="participation-activity"
            className="w-full sm:w-80"
            value={activityId || d.activityId || ""}
            onChange={(e) => {
              setActivityId(e.target.value);
              setPage(1);
            }}
          >
            {d.activities.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </NativeSelect>
        </div>
      )}
      <QueryState query={query}>
        {d && (!d.activityId ? (
          <EmptyState title="No activities yet" />
        ) : !d.items.length ? (
          <EmptyState title="No learners enrolled" />
        ) : (
          <>
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full min-w-[640px] text-sm">
                <caption className="sr-only">Participation of each learner in the selected activity</caption>
                <thead className="bg-muted/50 text-left">
                  <tr>
                    <th scope="col" className="px-3 py-2 font-medium">Learner</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Views</th>
                    <th scope="col" className="px-3 py-2 font-medium">Last viewed</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Submissions</th>
                    <th scope="col" className="px-3 py-2 font-medium">Completion</th>
                    <th scope="col" className="px-3 py-2"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {d.items.map((r) => (
                    <tr key={r.user.id} className={r.views === 0 ? "border-t bg-destructive/5" : "border-t"}>
                      <th scope="row" className="px-3 py-2 text-left font-medium">{fullName(r.user)}</th>
                      <td className="px-3 py-2 text-right tabular-nums">{r.views}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{r.views ? formatDate(r.lastViewedAt) : <span className="text-destructive">Not viewed</span>}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.submissions}</td>
                      <td className="px-3 py-2">{completionLabel(r.completion)}</td>
                      <td className="px-3 py-2 text-right">
                        <Button variant="ghost" size="sm" onClick={() => setOutlineUser(r.user)} aria-label={`Outline report for ${fullName(r.user)}`}>
                          Outline
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager page={page} pages={pages} onPage={setPage} />
          </>
        ))}
      </QueryState>
      <OutlineDialog courseId={courseId} user={outlineUser} onClose={() => setOutlineUser(null)} />
    </div>
  );
}

function Logs({ courseId }: { courseId: string }) {
  const [eventName, setEventName] = useState("");
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: ["reports", courseId, "logs", { eventName, page }],
    queryFn: () => api<LogPage>(`/reports/courses/${courseId}/logs`, { query: { eventName, page, pageSize: 50 } }),
    placeholderData: keepPreviousData,
  });
  const d = query.data;
  const pages = d ? Math.max(1, Math.ceil(d.total / d.pageSize)) : 1;
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
        <Label htmlFor="log-event">Event</Label>
        <NativeSelect
          id="log-event"
          className="w-full sm:w-64"
          value={eventName}
          onChange={(e) => {
            setEventName(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All events</option>
          {d?.eventNames.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </NativeSelect>
        {d && <span className="text-sm text-muted-foreground">{d.total.toLocaleString()} entries</span>}
      </div>
      <QueryState query={query}>
        {d &&
          (d.items.length ? (
            <>
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full min-w-[600px] text-sm">
                  <caption className="sr-only">Course event log</caption>
                  <thead className="bg-muted/50 text-left">
                    <tr>
                      <th scope="col" className="px-3 py-2 font-medium">Time</th>
                      <th scope="col" className="px-3 py-2 font-medium">User</th>
                      <th scope="col" className="px-3 py-2 font-medium">Event</th>
                      <th scope="col" className="px-3 py-2 font-medium">Activity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.items.map((r) => (
                      <tr key={r.id} className="border-t">
                        <td className="px-3 py-1.5 whitespace-nowrap">{formatDate(r.createdAt)}</td>
                        <td className="px-3 py-1.5">{r.user ? fullName(r.user) : <span className="text-muted-foreground">System</span>}</td>
                        <td className="px-3 py-1.5 font-mono text-xs">{r.eventName}</td>
                        <td className="px-3 py-1.5">
                          {r.activity ? (
                            <Link href={`/activities/${r.activity.id}`} className="hover:underline">
                              {r.activity.name}
                            </Link>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pager page={page} pages={pages} onPage={setPage} />
            </>
          ) : (
            <EmptyState title="No log entries" />
          ))}
      </QueryState>
    </div>
  );
}

export function CourseReports({ courseId }: { courseId: string }) {
  return (
    <Tabs defaultValue="overview">
      <TabsList className="w-full sm:w-fit">
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="participation">Participation</TabsTrigger>
        <TabsTrigger value="logs">Logs</TabsTrigger>
      </TabsList>
      <TabsContent value="overview" className="pt-4">
        <Overview courseId={courseId} />
      </TabsContent>
      <TabsContent value="participation" className="pt-4">
        <Participation courseId={courseId} />
      </TabsContent>
      <TabsContent value="logs" className="pt-4">
        <Logs courseId={courseId} />
      </TabsContent>
    </Tabs>
  );
}
