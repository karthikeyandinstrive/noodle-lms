"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, ExternalLink, PlayCircle, Video } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { EmptyState, fullName, QueryState } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, errorMessage } from "@/lib/api";
import { useFormat, useT, type Translate } from "@/lib/i18n";
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
/** Only the generic "Other" option needs translating; product names stay as-is. */
const providerLabel = (t: Translate, k: string) => (k === "custom" ? t("video.provider.custom", "Other (link)") : (PROVIDERS[k] ?? k));

function safeHttps(v: string | null | undefined) {
  if (!v) return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

function formatCountdown(t: Translate, ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return t("video.countdown.days", "{d}d {h}h {m}m", { d, h, m });
  if (h > 0) return t("video.countdown.hours", "{h}h {m}m {s}s", { h, m, s: sec });
  return t("video.countdown.minutes", "{m}m {s}s", { m, s: sec.toString().padStart(2, "0") });
}

/** Ticks every second; `offset` corrects for clock skew between browser and server. */
function useNow(offset: number) {
  const [now, setNow] = useState(() => Date.now() + offset);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() + offset), 1000);
    return () => clearInterval(timer);
  }, [offset]);
  return now;
}

function AttendanceReport({ activityId }: { activityId: string }) {
  const t = useT();
  const fmt = useFormat();
  const q = useQuery({ queryKey: ["video", activityId, "attendance"], queryFn: () => api<Attendance>(`/video/${activityId}/attendance`) });
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2 id="video-attendance">{t("video.attendance", "Attendance")}</h2>
        </CardTitle>
        {q.data && (
          <CardDescription>
            {t("video.attendanceSummary", "{joined} joined · {enrolled} enrolled", { joined: q.data.rows.length, enrolled: q.data.enrolledCount })}
          </CardDescription>
        )}
      </CardHeader>
      <CardContent>
        <QueryState query={q}>
          {q.data && !q.data.rows.length && <EmptyState title={t("video.nobodyJoined", "Nobody has joined yet")} />}
          {q.data && q.data.rows.length > 0 && (
            <div className="overflow-x-auto">
              <Table aria-labelledby="video-attendance">
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("video.participant", "Participant")}</TableHead>
                    <TableHead>{t("video.firstJoined", "First joined")}</TableHead>
                    <TableHead>{t("video.lastJoined", "Last joined")}</TableHead>
                    <TableHead className="text-right">{t("video.joins", "Joins")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {q.data.rows.map((r) => (
                    <TableRow key={r.user.id}>
                      <TableCell className="font-medium">{fullName(r.user)}</TableCell>
                      <TableCell>{fmt.date(r.firstJoinedAt)}</TableCell>
                      <TableCell>{fmt.date(r.lastJoinedAt)}</TableCell>
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
  const t = useT();
  const fmt = useFormat();
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
                    <Badge variant="outline">{providerLabel(t, s.provider)}</Badge>
                    {live && <Badge className="bg-red-600 text-white">{t("video.liveNow", "Live now")}</Badge>}
                    {now > ends && <Badge variant="secondary">{t("video.ended", "Ended")}</Badge>}
                    {s.myFirstJoinAt && <Badge variant="secondary">{t("video.youJoined", "You joined {date}", { date: fmt.date(s.myFirstJoinAt) })}</Badge>}
                  </div>
                  <dl className="grid gap-3 text-sm sm:grid-cols-2">
                    <div>
                      <dt className="text-muted-foreground">{t("video.starts", "Starts")}</dt>
                      <dd className="font-medium">{fmt.date(s.startsAt)}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">{t("video.ends", "Ends")}</dt>
                      <dd className="font-medium">{fmt.date(s.endsAt)}</dd>
                    </div>
                  </dl>
                  {now < starts && (
                    // Not a live region: it changes every second. role=timer is implicitly aria-live=off.
                    <p className="flex items-center gap-2 text-sm" role="timer">
                      <Clock className="size-4 text-muted-foreground" aria-hidden />
                      {t("video.startsIn", "Starts in")}{" "}
                      <span className="font-mono font-medium tabular-nums">{formatCountdown(t, starts - now)}</span>
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    <Button disabled={!joinable || join.isPending} onClick={() => join.mutate()}>
                      <Video aria-hidden />{" "}
                      {join.isPending
                        ? t("video.joining", "Joining…")
                        : s.canModerate && !windowOpen
                          ? t("video.openAsModerator", "Open meeting (moderator)")
                          : t("video.join", "Join meeting")}
                      <span className="sr-only">{t("video.opensNewTab", "(opens in a new tab)")}</span>
                    </Button>
                    {!joinable && now < opens && (
                      <p className="text-sm text-muted-foreground">{t("video.canJoinFrom", "You can join from {date}.", { date: fmt.date(s.opensAt) })}</p>
                    )}
                    {!joinable && now > closes && (
                      <p className="text-sm text-muted-foreground">{t("video.meetingEnded", "This meeting has ended.")}</p>
                    )}
                  </div>
                </CardContent>
              </Card>
              {recording && (
                <Card size="sm">
                  <CardContent className="flex flex-wrap items-center justify-between gap-3">
                    <span className="flex items-center gap-2 text-sm font-medium">
                      <PlayCircle className="size-4 text-primary" aria-hidden /> {t("video.recordingAvailable", "Recording available")}
                    </span>
                    <a href={recording} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: "outline", size: "sm" })}>
                      {t("video.watchRecording", "Watch recording")} <ExternalLink aria-hidden />
                      <span className="sr-only">{t("video.opensNewTab", "(opens in a new tab)")}</span>
                    </a>
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
  const t = useT();
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-1.5">
        <Label htmlFor="video-provider">{t("video.provider", "Provider")}</Label>
        <select id="video-provider" className={NativeSelectClass} value={provider} onChange={(e) => set("provider", e.target.value)}>
          {Object.keys(PROVIDERS).map((k) => (
            <option key={k} value={k}>
              {providerLabel(t, k)}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="video-start">{t("video.startsAt", "Starts at")}</Label>
        <Input
          id="video-start"
          type="datetime-local"
          required
          value={toLocalInput(value.startsAt as string | undefined)}
          onChange={(e) => set("startsAt", fromLocalInput(e.target.value))}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="video-duration">{t("video.duration", "Duration (minutes)")}</Label>
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
        (
        <p className="self-end text-sm text-muted-foreground sm:col-span-1">{t("video.jitsiAuto", "A private Jitsi room is created automatically.")}</p>
      )
      ) : (
        <div className="space-y-1.5">
          <Label htmlFor="video-join">{t("video.meetingLink", "Meeting link")}</Label>
          <Input
            id="video-join"
            type="url"
            placeholder={mode === "edit" ? t("video.keepLink", "Leave blank to keep the current link") : "https://…"}
            value={joinUrl}
            aria-invalid={badJoin || undefined}
            aria-describedby="video-join-help"
            onChange={(e) => set("joinUrl", e.target.value)}
          />
          <p id="video-join-help" className={badJoin ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
            {badJoin ? t("video.useHttps", "Use a https:// link.") : t("video.joinLinkHint", "Only shown to participants when the meeting opens.")}
          </p>
        </div>
      )}
      <div className="space-y-1.5 sm:col-span-2">
        <Label htmlFor="video-recording">{t("video.recordingLink", "Recording link (optional)")}</Label>
        <Input
          id="video-recording"
          type="url"
          placeholder="https://…"
          value={recordingUrl}
          aria-invalid={badRecording || undefined}
          aria-describedby={badRecording ? "video-recording-error" : undefined}
          onChange={(e) => set("recordingUrl", e.target.value || null)}
        />
        {badRecording && (
          <p id="video-recording-error" className="text-xs text-destructive" role="alert">
            {t("video.useHttps", "Use a https:// link.")}
          </p>
        )}
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
