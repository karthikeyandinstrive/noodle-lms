"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, ExternalLink, PlayCircle, Video } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { EmptyState, formatDate, fullName, QueryState } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, errorMessage } from "@/lib/api";
import type { UserSummary } from "@/lib/types";
import type { ActivityTypeUI, ActivityViewProps, SettingsFieldsProps } from "../activities/types";
import { fromLocalInput, NativeSelectClass, openInNewTab, toLocalInput } from "../certificate/shared";

type Status = {
  provider: string;
  startsAt: string;
  endsAt: string;
  opensAt: string;
  closesAt: string;
  open: boolean;
  canJoin: boolean;
  canModerate: boolean;
  myFirstJoinAt: string | null;
  recordingUrl: string | null;
  serverTime: string;
};
type Attendance = { enrolledCount: number; rows: { user: UserSummary; firstJoinedAt: string; lastJoinedAt: string; joins: number }[] };

const PROVIDERS: Record<string, string> = { jitsi: "Jitsi Meet", zoom: "Zoom", bigbluebutton: "BigBlueButton", custom: "Other (link)" };

function safeHttps(v: string | null | undefined) {
  if (!v) return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

function formatCountdown(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  return `${m}m ${sec.toString().padStart(2, "0")}s`;
}

/** Ticks every second; `offset` corrects for clock skew between browser and server. */
function useNow(offset: number) {
  const [now, setNow] = useState(() => Date.now() + offset);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() + offset), 1000);
    return () => clearInterval(t);
  }, [offset]);
  return now;
}

function AttendanceReport({ activityId }: { activityId: string }) {
  const q = useQuery({ queryKey: ["video", activityId, "attendance"], queryFn: () => api<Attendance>(`/video/${activityId}/attendance`) });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Attendance</CardTitle>
        {q.data && (
          <CardDescription>
            {q.data.rows.length} joined · {q.data.enrolledCount} enrolled
          </CardDescription>
        )}
      </CardHeader>
      <CardContent>
        <QueryState query={q}>
          {q.data && !q.data.rows.length && <EmptyState title="Nobody has joined yet" />}
          {q.data && q.data.rows.length > 0 && (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Participant</TableHead>
                    <TableHead>First joined</TableHead>
                    <TableHead>Last joined</TableHead>
                    <TableHead className="text-right">Joins</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {q.data.rows.map((r) => (
                    <TableRow key={r.user.id}>
                      <TableCell className="font-medium">{fullName(r.user)}</TableCell>
                      <TableCell>{formatDate(r.firstJoinedAt)}</TableCell>
                      <TableCell>{formatDate(r.lastJoinedAt)}</TableCell>
                      <TableCell className="text-right">{r.joins}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </QueryState>
      </CardContent>
    </Card>
  );
}

function View({ activity }: ActivityViewProps) {
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ["video", activity.id, "status"],
    queryFn: async () => {
      const s = await api<Status>(`/video/${activity.id}/status`);
      // Clock skew between this device and the server, so the countdown is accurate.
      return { ...s, offset: new Date(s.serverTime).getTime() - Date.now() };
    },
    refetchInterval: 60_000,
  });
  const now = useNow(status.data?.offset ?? 0);

  const join = useMutation({
    mutationFn: () => openInNewTab(async () => (await api<{ url: string }>(`/video/${activity.id}/join`, { body: {} })).url),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["video", activity.id] });
      void qc.invalidateQueries({ queryKey: ["activity", activity.id] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <QueryState query={status}>
      {status.data &&
        (() => {
          const s = status.data;
          const starts = new Date(s.startsAt).getTime();
          const ends = new Date(s.endsAt).getTime();
          const opens = new Date(s.opensAt).getTime();
          const closes = new Date(s.closesAt).getTime();
          const live = now >= starts && now <= ends;
          const windowOpen = now >= opens && now <= closes;
          const joinable = s.canModerate || (windowOpen && activity.capabilities["video:join"] === true);
          const recording = safeHttps(s.recordingUrl);
          return (
            <div className="space-y-4">
              <Card>
                <CardContent className="space-y-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">{PROVIDERS[s.provider] ?? s.provider}</Badge>
                    {live && <Badge className="bg-red-600 text-white">Live now</Badge>}
                    {now > ends && <Badge variant="secondary">Ended</Badge>}
                    {s.myFirstJoinAt && <Badge variant="secondary">You joined {formatDate(s.myFirstJoinAt)}</Badge>}
                  </div>
                  <dl className="grid gap-3 text-sm sm:grid-cols-2">
                    <div>
                      <dt className="text-muted-foreground">Starts</dt>
                      <dd className="font-medium">{formatDate(s.startsAt)}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Ends</dt>
                      <dd className="font-medium">{formatDate(s.endsAt)}</dd>
                    </div>
                  </dl>
                  {now < starts && (
                    <p className="flex items-center gap-2 text-sm" aria-live="polite">
                      <Clock className="size-4 text-muted-foreground" aria-hidden />
                      Starts in <span className="font-mono font-medium tabular-nums">{formatCountdown(starts - now)}</span>
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    <Button disabled={!joinable || join.isPending} onClick={() => join.mutate()}>
                      <Video /> {join.isPending ? "Joining…" : s.canModerate && !windowOpen ? "Open meeting (moderator)" : "Join meeting"}
                      <span className="sr-only">(opens in a new tab)</span>
                    </Button>
                    {!joinable && now < opens && <p className="text-sm text-muted-foreground">You can join from {formatDate(s.opensAt)}.</p>}
                    {!joinable && now > closes && <p className="text-sm text-muted-foreground">This meeting has ended.</p>}
                  </div>
                </CardContent>
              </Card>
              {recording && (
                <Card size="sm">
                  <CardContent className="flex flex-wrap items-center justify-between gap-3">
                    <span className="flex items-center gap-2 text-sm font-medium">
                      <PlayCircle className="size-4 text-primary" aria-hidden /> Recording available
                    </span>
                    <Button variant="outline" size="sm" render={<a href={recording} target="_blank" rel="noopener noreferrer" />}>
                      Watch recording <ExternalLink />
                    </Button>
                  </CardContent>
                </Card>
              )}
              {s.canModerate && <AttendanceReport activityId={activity.id} />}
            </div>
          );
        })()}
    </QueryState>
  );
}

function SettingsFields({ value, onChange, mode }: SettingsFieldsProps) {
  const provider = (value.provider as string) ?? "jitsi";
  const joinUrl = (value.joinUrl as string | null) ?? "";
  const recordingUrl = (value.recordingUrl as string | null) ?? "";
  const set = (k: string, v: unknown) => onChange({ ...value, [k]: v });
  const badJoin = joinUrl.trim() !== "" && !safeHttps(joinUrl.trim());
  const badRecording = recordingUrl.trim() !== "" && !safeHttps(recordingUrl.trim());
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-1.5">
        <Label htmlFor="video-provider">Provider</Label>
        <select id="video-provider" className={NativeSelectClass} value={provider} onChange={(e) => set("provider", e.target.value)}>
          {Object.entries(PROVIDERS).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="video-start">Starts at</Label>
        <Input
          id="video-start"
          type="datetime-local"
          required
          value={toLocalInput(value.startsAt as string | undefined)}
          onChange={(e) => set("startsAt", fromLocalInput(e.target.value))}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="video-duration">Duration (minutes)</Label>
        <Input
          id="video-duration"
          type="number"
          min={5}
          max={1440}
          value={String(value.durationMinutes ?? 60)}
          onChange={(e) => set("durationMinutes", Math.round(Number(e.target.value) || 0))}
        />
      </div>
      {provider === "jitsi" ? (
        <p className="self-end text-sm text-muted-foreground sm:col-span-1">A private Jitsi room is created automatically.</p>
      ) : (
        <div className="space-y-1.5">
          <Label htmlFor="video-join">Meeting link</Label>
          <Input
            id="video-join"
            type="url"
            placeholder={mode === "edit" ? "Leave blank to keep the current link" : "https://…"}
            value={joinUrl}
            aria-invalid={badJoin || undefined}
            onChange={(e) => set("joinUrl", e.target.value)}
          />
          <p className={badJoin ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
            {badJoin ? "Use a https:// link." : "Only shown to participants when the meeting opens."}
          </p>
        </div>
      )}
      <div className="space-y-1.5 sm:col-span-2">
        <Label htmlFor="video-recording">Recording link (optional)</Label>
        <Input
          id="video-recording"
          type="url"
          placeholder="https://…"
          value={recordingUrl}
          aria-invalid={badRecording || undefined}
          onChange={(e) => set("recordingUrl", e.target.value || null)}
        />
        {badRecording && <p className="text-xs text-destructive">Use a https:// link.</p>}
      </div>
    </div>
  );
}

function defaultStart() {
  const d = new Date(Date.now() + 24 * 3600_000);
  d.setMinutes(0, 0, 0);
  return d.toISOString();
}

export const videoActivity: ActivityTypeUI = {
  type: "video",
  label: "Video meeting",
  description: "Live video sessions",
  icon: Video,
  get defaults() {
    return { provider: "jitsi", startsAt: defaultStart(), durationMinutes: 60, joinUrl: null, recordingUrl: null };
  },
  defaultCompletion: "submit",
  View,
  SettingsFields,
};
