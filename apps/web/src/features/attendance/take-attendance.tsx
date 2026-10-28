"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, CheckCheck, MessageSquareText, Pencil, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState, ErrorAlert, QueryState, fullName } from "@/components/common";
import { api, errorMessage } from "@/lib/api";
import { useFormat, useLocale, useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  STATUSES,
  STATUS_CLASSES,
  attendanceKeys,
  sessionTime,
  statusLabel,
  statusShort,
  useAttendanceInfo,
  useSessionDetail,
  type AttendanceStatus,
  type SessionDetail,
} from "./api";
import { SessionDialog } from "./session-form";

type Changes = Record<string, { status?: AttendanceStatus; remarks?: string }>;
type Roster = SessionDetail["roster"];

export function TakeAttendance({ activityId, sessionId }: { activityId: string; sessionId: string }) {
  const query = useSessionDetail(activityId, sessionId);
  const info = useAttendanceInfo(activityId);
  const qc = useQueryClient();
  const router = useRouter();
  const t = useT();
  const fmt = useFormat();
  const locale = useLocale();
  const [changes, setChanges] = useState<Changes>({});
  const [openRemarks, setOpenRemarks] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const s = query.data;

  // `changes` holds only local edits on top of the server state.
  const current = (r: Roster[number]) => ({
    status: changes[r.user.id]?.status !== undefined ? changes[r.user.id]!.status! : r.status,
    remarks: changes[r.user.id]?.remarks !== undefined ? changes[r.user.id]!.remarks! : (r.remarks ?? ""),
  });
  const dirty = !!s && s.roster.some((r) => {
    const c = current(r);
    return c.status !== r.status || c.remarks !== (r.remarks ?? "");
  });
  const unmarked = s ? s.roster.filter((r) => !current(r).status).length : 0;

  const save = useMutation({
    mutationFn: () =>
      api<{ saved: number }>(`/attendance/${activityId}/sessions/${sessionId}/records`, {
        method: "PUT",
        body: {
          records: (s?.roster ?? [])
            .map((r) => ({ userId: r.user.id, ...current(r) }))
            .filter((r) => r.status)
            .map((r) => ({ userId: r.userId, status: r.status, remarks: r.remarks.trim() || null })),
        },
      }),
    onSuccess: async (r) => {
      toast.success(
        r.saved === 1
          ? t("attendance.savedFor.one", "Attendance saved for {n} student", { n: r.saved })
          : t("attendance.savedFor.other", "Attendance saved for {n} students", { n: r.saved }),
      );
      await qc.invalidateQueries({ queryKey: attendanceKeys.all(activityId) });
      setChanges({});
    },
  });

  const remove = useMutation({
    mutationFn: () => api(`/attendance/${activityId}/sessions/${sessionId}`, { method: "DELETE" }),
    onSuccess: async () => {
      toast.success(t("attendance.sessionDeleted", "Session deleted"));
      await qc.invalidateQueries({ queryKey: attendanceKeys.all(activityId) });
      router.push(`/activities/${activityId}`);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const setStatus = (userId: string, status: AttendanceStatus) => setChanges((c) => ({ ...c, [userId]: { ...c[userId], status } }));
  const setRemarks = (userId: string, remarks: string) => setChanges((c) => ({ ...c, [userId]: { ...c[userId], remarks } }));
  const markRest = (status: AttendanceStatus) =>
    setChanges((c) => {
      const next = { ...c };
      for (const r of s?.roster ?? []) if (!current(r).status) next[r.user.id] = { ...next[r.user.id], status };
      return next;
    });

  return (
    <QueryState query={query}>
      {s && (
        <div className="space-y-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">{sessionTime(s, locale)}</h1>
              <p className="mt-1 flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
                {s.description && <span>{s.description}</span>}
                {s.groupName && <Badge variant="outline">{s.groupName}</Badge>}
                {s.takenAt ? (
                  <span>{t("attendance.lastTaken", "Last taken {date}", { date: fmt.date(s.takenAt) })}</span>
                ) : (
                  <span>{t("attendance.notTakenYet", "Not taken yet")}</span>
                )}
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                <Pencil aria-hidden /> {t("common.edit", "Edit")}
              </Button>
              <Button variant="outline" size="sm" className="text-destructive" onClick={() => setDeleting(true)}>
                <Trash2 aria-hidden /> {t("common.delete", "Delete")}
              </Button>
            </div>
          </div>

          {s.roster.length === 0 ? (
            <EmptyState
              title={t("attendance.noStudentsInSession", "No students in this session")}
              description={t("attendance.noStudentsInSessionHint", "Enrol students (or add them to the session’s group) to take attendance.")}
            />
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm text-muted-foreground" aria-live="polite">
                  {s.roster.length === 1
                    ? t("attendance.studentCount.one", "{n} student", { n: s.roster.length })
                    : t("attendance.studentCount.other", "{n} students", { n: s.roster.length })}{" "}
                  · {t("attendance.unmarkedCount", "{n} unmarked", { n: unmarked })}
                </p>
                <Button variant="outline" size="sm" disabled={!unmarked} onClick={() => markRest("present")}>
                  <CheckCheck aria-hidden /> {t("attendance.markUnmarkedPresent", "Mark unmarked present")}
                </Button>
              </div>

              {save.isError && <ErrorAlert error={save.error} />}

              <ul className="divide-y rounded-xl border" aria-label={t("attendance.roster", "Students")}>
                {s.roster.map((r) => {
                  const d = current(r);
                  const name = fullName(r.user);
                  return (
                    <li key={r.user.id} className="space-y-2 p-3">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{name}</p>
                          {r.selfMarked && <p className="text-xs text-muted-foreground">{t("attendance.selfMarkedOn", "Self-marked {date}", { date: fmt.date(r.takenAt) })}</p>}
                        </div>
                        <div className="flex items-center gap-1">
                          <div role="group" aria-label={t("attendance.statusFor", "Status for {name}", { name })} className="flex gap-1">
                            {STATUSES.map((st) => {
                              const active = d.status === st;
                              const label = statusLabel(t, st);
                              return (
                                <button
                                  key={st}
                                  type="button"
                                  aria-pressed={active}
                                  aria-label={t("attendance.markStatusFor", "{status}: {name}", { status: label, name })}
                                  title={label}
                                  onClick={() => setStatus(r.user.id, st)}
                                  className={cn(
                                    "flex h-9 min-w-9 items-center justify-center gap-1 rounded-lg border px-2 text-sm font-semibold transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 sm:min-w-11",
                                    active ? cn("border-transparent", STATUS_CLASSES[st]) : "bg-background text-muted-foreground hover:bg-muted",
                                  )}
                                >
                                  {active && <Check className="size-3.5" aria-hidden />}
                                  <span className="sm:hidden" aria-hidden>
                                    {statusShort(t, st)}
                                  </span>
                                  <span className="hidden sm:inline" aria-hidden>
                                    {label}
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                          <Button
                            type="button"
                            size="icon"
                            variant={d.remarks ? "secondary" : "ghost"}
                            aria-label={t("attendance.remarksFor", "Remarks for {name}", { name })}
                            aria-expanded={!!openRemarks[r.user.id]}
                            onClick={() => setOpenRemarks((o) => ({ ...o, [r.user.id]: !o[r.user.id] }))}
                          >
                            <MessageSquareText aria-hidden />
                          </Button>
                        </div>
                      </div>
                      {openRemarks[r.user.id] && (
                        <Input
                          aria-label={t("attendance.remarksFor", "Remarks for {name}", { name })}
                          placeholder={t("attendance.remarksPlaceholder", "Remarks (optional)")}
                          maxLength={500}
                          value={d.remarks}
                          onChange={(e) => setRemarks(r.user.id, e.target.value)}
                        />
                      )}
                    </li>
                  );
                })}
              </ul>

              <div className="sticky bottom-0 -mx-1 flex items-center justify-end gap-2 border-t bg-background/95 px-1 py-3 backdrop-blur">
                <span className="mr-auto text-sm text-muted-foreground" role="status">
                  {dirty ? t("attendance.unsavedChanges", "Unsaved changes") : ""}
                </span>
                <Button disabled={save.isPending || (!dirty && !!s.takenAt) || s.roster.length === unmarked} onClick={() => save.mutate()}>
                  {save.isPending ? t("common.saving", "Saving…") : t("attendance.saveAttendance", "Save attendance")}
                </Button>
              </div>
            </>
          )}

          {editing && (
            <SessionDialog activityId={activityId} groups={info.data?.groups ?? []} open={editing} onOpenChange={setEditing} session={s} />
          )}
          <AlertDialog open={deleting} onOpenChange={setDeleting}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("attendance.deleteSessionTitle", "Delete this session?")}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t("attendance.deleteSessionDesc", "Its attendance records are removed and students’ grades are recalculated.")}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("common.cancel", "Cancel")}</AlertDialogCancel>
                <Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate()}>
                  {remove.isPending ? t("attendance.deleting", "Deleting…") : t("attendance.deleteSession", "Delete session")}
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      )}
    </QueryState>
  );
}
