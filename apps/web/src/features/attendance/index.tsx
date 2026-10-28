"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CalendarCheck, CalendarPlus, ClipboardList, Download, KeyRound, UserCheck } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState, ErrorAlert, QueryState, fullName } from "@/components/common";
import { activityKey } from "@/features/activities/use-activity";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { ActivityTypeUI, ActivityViewProps, SettingsFieldsProps } from "../activities/types";
import {
  STATUSES,
  STATUS_CLASSES,
  STATUS_LABELS,
  STATUS_SHORT,
  attendanceKeys,
  csvUrl,
  sessionTime,
  useAttendanceInfo,
  useReport,
  useSessions,
  type AttendanceInfo,
  type AttendanceStatus,
  type Session,
  type Summary,
} from "./api";
import { SessionDialog } from "./session-form";

export function StatusBadge({ status }: { status: AttendanceStatus | null }) {
  if (!status) return <span className="text-xs text-muted-foreground">—</span>;
  return <Badge className={cn("border-transparent", STATUS_CLASSES[status])}>{STATUS_LABELS[status]}</Badge>;
}

function AttendanceView({ activity }: ActivityViewProps) {
  const info = useAttendanceInfo(activity.id);
  return (
    <QueryState query={info}>
      {info.data && (info.data.canViewAll ? <StaffView activityId={activity.id} info={info.data} /> : <LearnerView activityId={activity.id} info={info.data} />)}
    </QueryState>
  );
}

// ─── Learner ────────────────────────────────────────────────────────────────

function SummaryCards({ summary, gradeMax }: { summary: Summary; gradeMax: number }) {
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <div className="rounded-lg border p-3">
        <dt className="text-xs text-muted-foreground">Attendance</dt>
        <dd className="text-xl font-semibold tabular-nums">{summary.percentage === null ? "—" : `${summary.percentage}%`}</dd>
      </div>
      <div className="rounded-lg border p-3">
        <dt className="text-xs text-muted-foreground">Grade</dt>
        <dd className="text-xl font-semibold tabular-nums">
          {summary.grade === null ? "—" : Math.round(summary.grade * 100) / 100}
          <span className="text-sm font-normal text-muted-foreground"> / {gradeMax}</span>
        </dd>
      </div>
      <div className="col-span-2 rounded-lg border p-3">
        <dt className="text-xs text-muted-foreground">{summary.sessions} sessions counted</dt>
        <dd className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm">
          {STATUSES.map((s) => (
            <span key={s}>
              {STATUS_LABELS[s]} <strong className="tabular-nums">{summary.counts[s]}</strong>
            </span>
          ))}
        </dd>
      </div>
    </dl>
  );
}

function LearnerView({ activityId, info }: { activityId: string; info: AttendanceInfo }) {
  const sessions = useSessions(activityId);
  const [marking, setMarking] = useState<Session | null>(null);
  const [now] = useState(() => Date.now());

  return (
    <div className="space-y-6">
      {info.mySummary && <SummaryCards summary={info.mySummary} gradeMax={info.gradeMax} />}
      <section className="space-y-3" aria-labelledby="my-sessions">
        <h2 id="my-sessions" className="text-lg font-semibold">
          Sessions
        </h2>
        <QueryState query={sessions}>
          {sessions.data &&
            (sessions.data.length === 0 ? (
              <EmptyState title="No sessions scheduled" />
            ) : (
              <ul className="divide-y rounded-xl border">
                {sessions.data.map((s) => {
                  const past = new Date(s.startsAt).getTime() + s.durationMinutes * 60_000 < now;
                  return (
                    <li key={s.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{sessionTime(s)}</p>
                        {(s.description || s.groupName) && (
                          <p className="text-xs break-words text-muted-foreground">{[s.description, s.groupName].filter(Boolean).join(" · ")}</p>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        {s.myStatus ? (
                          <StatusBadge status={s.myStatus} />
                        ) : s.selfMarkOpen ? (
                          <Button size="sm" onClick={() => setMarking(s)}>
                            <UserCheck /> Mark me present
                          </Button>
                        ) : s.takenAt ? (
                          <StatusBadge status="absent" />
                        ) : (
                          <span className="text-xs text-muted-foreground">{past ? "Not recorded" : "Upcoming"}</span>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            ))}
        </QueryState>
      </section>
      {marking && <SelfMarkDialog activityId={activityId} session={marking} onClose={() => setMarking(null)} />}
    </div>
  );
}

function SelfMarkDialog({ activityId, session, onClose }: { activityId: string; session: Session; onClose: () => void }) {
  const qc = useQueryClient();
  const [code, setCode] = useState("");
  const mark = useMutation({
    mutationFn: () => api(`/attendance/${activityId}/sessions/${session.id}/self-mark`, { body: session.hasCode ? { code } : {} }),
    onSuccess: async () => {
      toast.success("You're marked present");
      onClose();
      await qc.invalidateQueries({ queryKey: attendanceKeys.all(activityId) });
      await qc.invalidateQueries({ queryKey: activityKey(activityId) });
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            mark.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>Mark your attendance</DialogTitle>
            <DialogDescription>{sessionTime(session)}</DialogDescription>
          </DialogHeader>
          {mark.isError && <ErrorAlert error={mark.error} />}
          {session.hasCode && (
            <div className="space-y-1.5">
              <Label htmlFor="sm-code">
                <KeyRound className="size-4" /> Session code
              </Label>
              <Input id="sm-code" autoComplete="off" autoCapitalize="characters" required maxLength={32} value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
              <p className="text-xs text-muted-foreground">Your teacher will share the code during the session.</p>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={mark.isPending || (session.hasCode && !code.trim())}>
              {mark.isPending ? "Saving…" : "I'm here"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Staff ──────────────────────────────────────────────────────────────────

function StaffView({ activityId, info }: { activityId: string; info: AttendanceInfo }) {
  return (
    <Tabs defaultValue="sessions">
      <TabsList>
        <TabsTrigger value="sessions">
          <CalendarCheck /> Sessions
        </TabsTrigger>
        <TabsTrigger value="report">
          <ClipboardList /> Report
        </TabsTrigger>
      </TabsList>
      <TabsContent value="sessions" className="pt-3">
        <SessionsPanel activityId={activityId} info={info} />
      </TabsContent>
      <TabsContent value="report" className="pt-3">
        <ReportPanel activityId={activityId} />
      </TabsContent>
    </Tabs>
  );
}

function SessionsPanel({ activityId, info }: { activityId: string; info: AttendanceInfo }) {
  const sessions = useSessions(activityId);
  const [adding, setAdding] = useState(false);
  const [now] = useState(() => Date.now());

  return (
    <div className="space-y-3">
      {info.canTake && (
        <div className="flex justify-end">
          <Button onClick={() => setAdding(true)}>
            <CalendarPlus /> Add sessions
          </Button>
        </div>
      )}
      <QueryState query={sessions}>
        {sessions.data &&
          (sessions.data.length === 0 ? (
            <EmptyState title="No sessions yet" description={info.canTake ? "Add a single session or a weekly series." : undefined} />
          ) : (
            <ul className="divide-y rounded-xl border">
              {sessions.data.map((s) => {
                const upcoming = new Date(s.startsAt).getTime() > now;
                return (
                  <li key={s.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                        {sessionTime(s)}
                        {s.groupName && <Badge variant="outline">{s.groupName}</Badge>}
                        {s.hasCode && (
                          <Badge variant="outline">
                            <KeyRound /> Code
                          </Badge>
                        )}
                      </p>
                      <p className="text-xs break-words text-muted-foreground">
                        {s.description ? `${s.description} · ` : ""}
                        {s.takenAt ? `Taken · ${s.recorded} recorded` : s.recorded ? `${s.recorded} self-marked` : upcoming ? "Upcoming" : "Not taken"}
                      </p>
                    </div>
                    {info.canTake && (
                      <Button size="sm" variant={s.takenAt ? "outline" : "default"} render={<Link href={`/activities/${activityId}/attendance/sessions/${s.id}`} />}>
                        {s.takenAt ? "Update" : "Take attendance"}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          ))}
      </QueryState>
      {adding && <SessionDialog activityId={activityId} groups={info.groups} open={adding} onOpenChange={setAdding} />}
    </div>
  );
}

function ReportPanel({ activityId }: { activityId: string }) {
  const report = useReport(activityId, true);
  const shortDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });

  return (
    <QueryState query={report}>
      {report.data && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              {STATUSES.map((s) => `${STATUS_SHORT[s]} = ${STATUS_LABELS[s]}`).join(" · ")}
            </p>
            <Button variant="outline" size="sm" render={<a href={csvUrl(activityId)} download />}>
              <Download /> Export CSV
            </Button>
          </div>
          {report.data.rows.length === 0 ? (
            <EmptyState title="No students yet" />
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="sticky left-0 z-10 bg-background">Student</TableHead>
                    <TableHead className="text-right">%</TableHead>
                    <TableHead className="text-right">Grade</TableHead>
                    {STATUSES.map((s) => (
                      <TableHead key={s} className="text-center" title={STATUS_LABELS[s]}>
                        {STATUS_SHORT[s]}
                      </TableHead>
                    ))}
                    {report.data.sessions.map((s) => (
                      <TableHead key={s.id} className="text-center text-xs whitespace-nowrap" title={s.groupName ?? undefined}>
                        <Link href={`/activities/${activityId}/attendance/sessions/${s.id}`} className="hover:underline">
                          {shortDate(s.startsAt)}
                        </Link>
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.data.rows.map((r) => (
                    <TableRow key={r.user.id}>
                      <TableCell className="sticky left-0 z-10 bg-background font-medium whitespace-nowrap">{fullName(r.user)}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.summary.percentage === null ? "—" : `${r.summary.percentage}%`}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.summary.grade === null ? "—" : Math.round(r.summary.grade * 100) / 100}</TableCell>
                      {STATUSES.map((s) => (
                        <TableCell key={s} className="text-center tabular-nums">
                          {r.summary.counts[s]}
                        </TableCell>
                      ))}
                      {report.data!.sessions.map((s) => {
                        if (!(s.id in r.statuses)) {
                          return (
                            <TableCell key={s.id} className="text-center text-xs text-muted-foreground" title="Not in this session's group">
                              ·
                            </TableCell>
                          );
                        }
                        const st = r.statuses[s.id] ?? (s.taken ? "absent" : null);
                        return (
                          <TableCell key={s.id} className="text-center">
                            {st ? (
                              <span
                                className={cn("inline-flex size-6 items-center justify-center rounded text-xs font-semibold", STATUS_CLASSES[st])}
                                title={STATUS_LABELS[st]}
                              >
                                {STATUS_SHORT[st]}
                                <span className="sr-only"> {STATUS_LABELS[st]}</span>
                              </span>
                            ) : (
                              <span className="text-xs text-muted-foreground">–</span>
                            )}
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      )}
    </QueryState>
  );
}

// ─── Settings ───────────────────────────────────────────────────────────────

const DEFAULT_POINTS: Record<AttendanceStatus, number> = { present: 2, late: 1, excused: 1, absent: 0 };

function AttendanceSettings({ value, onChange }: SettingsFieldsProps) {
  const set = (k: string, v: unknown) => onChange({ ...value, [k]: v });
  const points = { ...DEFAULT_POINTS, ...((value.statusPoints as Partial<Record<AttendanceStatus, number>>) ?? {}) };
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="att-grade">Maximum grade</Label>
          <Input
            id="att-grade"
            type="number"
            min={0}
            max={1000}
            step="any"
            value={String(value.gradeMax ?? 100)}
            onChange={(e) => set("gradeMax", Math.max(0, Number(e.target.value) || 0))}
          />
        </div>
        <div className="flex items-center gap-2 sm:pt-6">
          <Switch id="att-self" checked={!!value.allowSelfMarking} onCheckedChange={(v) => set("allowSelfMarking", v)} />
          <Label htmlFor="att-self" className="font-normal">
            Students can mark themselves present
          </Label>
        </div>
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Points per status</legend>
        <p className="text-xs text-muted-foreground">Grade = points earned ÷ (sessions × highest status points) × maximum grade.</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {STATUSES.map((s) => (
            <div key={s} className="space-y-1">
              <Label htmlFor={`pts-${s}`} className="text-xs">
                {STATUS_LABELS[s]}
              </Label>
              <Input
                id={`pts-${s}`}
                type="number"
                min={0}
                max={100}
                step="any"
                value={String(points[s])}
                onChange={(e) => set("statusPoints", { ...points, [s]: Math.max(0, Number(e.target.value) || 0) })}
              />
            </div>
          ))}
        </div>
      </fieldset>
    </div>
  );
}

export const attendanceActivity: ActivityTypeUI = {
  type: "attendance",
  label: "Attendance",
  description: "Track session attendance",
  icon: CalendarCheck,
  defaults: { gradeMax: 100, statusPoints: DEFAULT_POINTS, allowSelfMarking: false },
  defaultCompletion: "submit",
  View: AttendanceView,
  SettingsFields: AttendanceSettings,
};
