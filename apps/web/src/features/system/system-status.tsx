"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileWarning, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, PageHeader, QueryState } from "@/components/common";
import { ConfirmDialog, Field, NativeSelect, Pager, RequireCapability } from "@/features/admin/shared";
import { api, errorMessage, type Paged } from "@/lib/api";
import { useFormat, useT, type Translate } from "@/lib/i18n";
import { JOB_STATUSES, type FailedEvent, type JobStatus, type ServiceStatus, type SystemHealth, type SystemJob } from "./types";

const KEY = ["admin", "system"] as const;

function ErrorDetails({ title, subtitle, error, onClose }: { title: string; subtitle?: string; error: string | null; onClose: () => void }) {
  return (
    <Dialog open={error !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-mono text-base break-all">{title}</DialogTitle>
          {subtitle && <DialogDescription>{subtitle}</DialogDescription>}
        </DialogHeader>
        <pre className="max-h-[60vh] overflow-auto rounded-lg bg-muted p-3 text-xs leading-relaxed break-all whitespace-pre-wrap">{error}</pre>
      </DialogContent>
    </Dialog>
  );
}

function statusLabel(t: Translate, s: ServiceStatus) {
  if (s === "ok") return t("system.status.ok", "OK");
  if (s === "disabled") return t("system.status.disabled", "Not configured");
  return t("system.status.error", "Unreachable");
}

function StatCard({ title, value, hint, tone = "default" }: { title: string; value: React.ReactNode; hint?: React.ReactNode; tone?: "default" | "bad" }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardDescription>{title}</CardDescription>
        <CardTitle className={tone === "bad" ? "text-2xl text-destructive" : "text-2xl"}>{value}</CardTitle>
      </CardHeader>
      {hint && <CardContent className="text-xs text-muted-foreground">{hint}</CardContent>}
    </Card>
  );
}

function formatAge(t: Translate, seconds: number) {
  if (seconds < 60) return t("system.age.seconds", "{n}s", { n: seconds });
  if (seconds < 3600) return t("system.age.minutes", "{n} min", { n: Math.round(seconds / 60) });
  return t("system.age.hours", "{n} h", { n: Math.round(seconds / 3600) });
}

function HealthSection() {
  const t = useT();
  const fmt = useFormat();
  const health = useQuery({ queryKey: [...KEY, "health"], queryFn: () => api<SystemHealth>("/admin/system/health"), refetchInterval: 15_000 });
  const h = health.data;
  return (
    <section aria-labelledby="system-health" className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h2 id="system-health" className="text-lg font-semibold">
          {t("system.health.title", "Health")}
        </h2>
        <Button variant="outline" size="sm" onClick={() => void health.refetch()} disabled={health.isFetching}>
          <RefreshCw aria-hidden className={health.isFetching ? "animate-spin" : undefined} />
          {t("system.refresh", "Refresh")}
        </Button>
      </div>
      <QueryState query={health}>
        {h && (
          <>
            <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
              <StatCard title={t("system.health.database", "Database")} value={statusLabel(t, h.db)} tone={h.db === "error" ? "bad" : "default"} />
              <StatCard title={t("system.health.redis", "Redis")} value={statusLabel(t, h.redis)} tone={h.redis === "error" ? "bad" : "default"} />
              <StatCard
                title={t("system.health.queue", "Queued jobs")}
                value={fmt.number(h.queue.depth)}
                hint={
                  h.queue.oldestQueuedAgeSeconds !== null
                    ? t("system.health.oldest", "Oldest waiting {age}", { age: formatAge(t, h.queue.oldestQueuedAgeSeconds) })
                    : t("system.health.queueEmpty", "Nothing waiting")
                }
              />
              <StatCard title={t("system.health.failedJobs", "Failed jobs")} value={fmt.number(h.queue.failedJobs)} tone={h.queue.failedJobs ? "bad" : "default"} />
              <StatCard title={t("system.health.pendingEvents", "Events not yet dispatched")} value={fmt.number(h.queue.undispatchedEvents)} />
              <StatCard title={t("system.health.failedEvents", "Events with errors")} value={fmt.number(h.queue.failedEvents)} tone={h.queue.failedEvents ? "bad" : "default"} />
              <StatCard title={t("system.health.version", "App version")} value={<span className="font-mono">{h.version}</span>} />
            </div>
            <div className="overflow-x-auto rounded-xl border">
              <Table aria-label={t("system.tasks.title", "Scheduled tasks")}>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("system.tasks.task", "Scheduled task")}</TableHead>
                    <TableHead>{t("system.tasks.every", "Every")}</TableHead>
                    <TableHead>{t("system.tasks.lastRun", "Last run")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {h.tasks.map((task) => (
                    <TableRow key={task.name}>
                      <TableCell>
                        <code className="text-xs">{task.name}</code>
                        {task.running && (
                          <Badge variant="secondary" className="ml-2">
                            {t("system.tasks.running", "Running")}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{formatAge(t, task.intervalSeconds)}</TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {task.lastRunAt ? fmt.date(task.lastRunAt) : t("system.tasks.never", "Never")}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </QueryState>
    </section>
  );
}

function jobStatusLabel(t: Translate, s: JobStatus) {
  return {
    queued: t("system.jobs.status.queued", "Queued"),
    running: t("system.jobs.status.running", "Running"),
    done: t("system.jobs.status.done", "Done"),
    failed: t("system.jobs.status.failed", "Failed"),
  }[s];
}

function JobsSection() {
  const t = useT();
  const fmt = useFormat();
  const qc = useQueryClient();
  const [status, setStatus] = useState<JobStatus | "">("failed");
  const [page, setPage] = useState(1);
  const [viewing, setViewing] = useState<SystemJob | null>(null);
  const [deleting, setDeleting] = useState<SystemJob | null>(null);
  const jobs = useQuery({
    queryKey: [...KEY, "jobs", { status, page }],
    queryFn: () => api<Paged<SystemJob>>("/admin/system/jobs", { query: { status: status || undefined, page, pageSize: 25 } }),
    placeholderData: keepPreviousData,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: KEY });
  const retry = useMutation({
    mutationFn: (id: string) => api(`/admin/system/jobs/${id}/retry`, { method: "POST" }),
    onSuccess: () => {
      toast.success(t("system.jobs.retried", "Job queued again"));
      void refresh();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/admin/system/jobs/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(t("system.jobs.deleted", "Job deleted"));
      setDeleting(null);
      void refresh();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <section aria-labelledby="system-jobs" className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 id="system-jobs" className="text-lg font-semibold">
            {t("system.jobs.title", "Background jobs")}
          </h2>
          <p className="text-sm text-muted-foreground">{t("system.jobs.description", "Emails, reminders and other work run by the background worker.")}</p>
        </div>
        <Field id="job-status" label={t("system.jobs.filter", "Status")} className="sm:w-44">
          <NativeSelect
            id="job-status"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as JobStatus | "");
              setPage(1);
            }}
          >
            <option value="">{t("system.jobs.allStatuses", "All statuses")}</option>
            {JOB_STATUSES.map((s) => (
              <option key={s} value={s}>
                {jobStatusLabel(t, s)}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>
      <QueryState query={jobs}>
        {jobs.data && jobs.data.items.length === 0 ? (
          <EmptyState title={t("system.jobs.empty", "No jobs")} description={t("system.jobs.emptyHelp", "No jobs match this filter.")} />
        ) : (
          jobs.data && (
            <>
              <div className="overflow-x-auto rounded-xl border">
                <Table aria-label={t("system.jobs.title", "Background jobs")}>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("system.jobs.name", "Job")}</TableHead>
                      <TableHead>{t("system.jobs.filter", "Status")}</TableHead>
                      <TableHead className="hidden sm:table-cell">{t("system.jobs.attempts", "Attempts")}</TableHead>
                      <TableHead className="hidden md:table-cell">{t("system.jobs.created", "Created")}</TableHead>
                      <TableHead className="hidden lg:table-cell">{t("system.jobs.runAt", "Next run")}</TableHead>
                      <TableHead>
                        <span className="sr-only">{t("system.actions", "Actions")}</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {jobs.data.items.map((job) => (
                      <TableRow key={job.id}>
                        <TableCell>
                          <code className="text-xs break-all">{job.name}</code>
                        </TableCell>
                        <TableCell>
                          <Badge variant={job.status === "failed" ? "destructive" : job.status === "done" ? "outline" : "secondary"}>{jobStatusLabel(t, job.status)}</Badge>
                        </TableCell>
                        <TableCell className="hidden sm:table-cell">
                          {job.attempts}/{job.maxAttempts}
                        </TableCell>
                        <TableCell className="hidden whitespace-nowrap text-muted-foreground md:table-cell">{fmt.date(job.createdAt)}</TableCell>
                        <TableCell className="hidden whitespace-nowrap text-muted-foreground lg:table-cell">
                          {job.status === "queued" ? fmt.date(job.runAt) : "—"}
                        </TableCell>
                        <TableCell>
                          <div className="flex justify-end gap-1">
                            {job.lastError && (
                              <Button variant="ghost" size="icon-sm" aria-label={t("system.viewError", "View error of {name}", { name: job.name })} onClick={() => setViewing(job)}>
                                <FileWarning aria-hidden />
                              </Button>
                            )}
                            {job.status === "failed" && (
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={t("system.jobs.retry", "Retry {name}", { name: job.name })}
                                disabled={retry.isPending}
                                onClick={() => retry.mutate(job.id)}
                              >
                                <RotateCcw aria-hidden />
                              </Button>
                            )}
                            {job.status !== "running" && job.status !== "done" && (
                              <Button variant="ghost" size="icon-sm" aria-label={t("system.jobs.delete", "Delete {name}", { name: job.name })} onClick={() => setDeleting(job)}>
                                <Trash2 aria-hidden />
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <Pager page={jobs.data.page} pageSize={jobs.data.pageSize} total={jobs.data.total} onPage={setPage} />
            </>
          )
        )}
      </QueryState>
      <ErrorDetails
        title={viewing?.name ?? ""}
        subtitle={viewing ? t("system.jobs.errorSubtitle", "Attempt {attempts} of {max}", { attempts: viewing.attempts, max: viewing.maxAttempts }) : undefined}
        error={viewing?.lastError ?? null}
        onClose={() => setViewing(null)}
      />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={t("system.jobs.deleteTitle", "Delete this job?")}
        description={t("system.jobs.deleteHelp", "The job {name} will not run. This cannot be undone.", { name: deleting?.name ?? "" })}
        confirmLabel={t("system.jobs.deleteConfirm", "Delete job")}
        destructive
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </section>
  );
}

function FailedEventsSection() {
  const t = useT();
  const fmt = useFormat();
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [viewing, setViewing] = useState<FailedEvent | null>(null);
  const events = useQuery({
    queryKey: [...KEY, "failed-events", { page }],
    queryFn: () => api<Paged<FailedEvent>>("/admin/system/failed-events", { query: { page, pageSize: 25 } }),
    placeholderData: keepPreviousData,
  });
  const retry = useMutation({
    mutationFn: (id: string) => api(`/admin/system/failed-events/${id}/retry`, { method: "POST" }),
    onSuccess: () => {
      toast.success(t("system.events.retried", "The event will be dispatched again shortly"));
      void qc.invalidateQueries({ queryKey: KEY });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <section aria-labelledby="system-events" className="space-y-4">
      <div>
        <h2 id="system-events" className="text-lg font-semibold">
          {t("system.events.title", "Failed events")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t("system.events.description", "Domain events with a subscriber that failed. Retrying re-runs only the subscribers that have not succeeded.")}
        </p>
      </div>
      <QueryState query={events}>
        {events.data && events.data.items.length === 0 ? (
          <EmptyState title={t("system.events.empty", "No failed events")} description={t("system.events.emptyHelp", "Every event was delivered to its subscribers.")} />
        ) : (
          events.data && (
            <>
              <div className="overflow-x-auto rounded-xl border">
                <Table aria-label={t("system.events.title", "Failed events")}>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("system.events.name", "Event")}</TableHead>
                      <TableHead>{t("system.events.state", "State")}</TableHead>
                      <TableHead className="hidden sm:table-cell">{t("system.jobs.attempts", "Attempts")}</TableHead>
                      <TableHead className="hidden md:table-cell">{t("system.events.created", "Created")}</TableHead>
                      <TableHead>
                        <span className="sr-only">{t("system.actions", "Actions")}</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {events.data.items.map((e) => (
                      <TableRow key={e.id}>
                        <TableCell>
                          <code className="text-xs break-all">{e.name}</code>
                        </TableCell>
                        <TableCell>
                          {e.gaveUp ? (
                            <Badge variant="destructive">{t("system.events.gaveUp", "Gave up")}</Badge>
                          ) : (
                            <Badge variant="secondary">{t("system.events.retrying", "Retrying {when}", { when: fmt.date(e.nextAttemptAt) })}</Badge>
                          )}
                        </TableCell>
                        <TableCell className="hidden sm:table-cell">{e.attempts}</TableCell>
                        <TableCell className="hidden whitespace-nowrap text-muted-foreground md:table-cell">{fmt.date(e.createdAt)}</TableCell>
                        <TableCell>
                          <div className="flex justify-end gap-1">
                            <Button variant="ghost" size="icon-sm" aria-label={t("system.viewError", "View error of {name}", { name: e.name })} onClick={() => setViewing(e)}>
                              <FileWarning aria-hidden />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={t("system.events.retry", "Retry {name} now", { name: e.name })}
                              disabled={retry.isPending}
                              onClick={() => retry.mutate(e.id)}
                            >
                              <RotateCcw aria-hidden />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <Pager page={events.data.page} pageSize={events.data.pageSize} total={events.data.total} onPage={setPage} />
            </>
          )
        )}
      </QueryState>
      <ErrorDetails
        title={viewing?.name ?? ""}
        subtitle={
          viewing?.completedHandlers.length
            ? t("system.events.succeeded", "Succeeded: {handlers}", { handlers: viewing.completedHandlers.join(", ") })
            : undefined
        }
        error={viewing ? (viewing.lastError ?? "") : null}
        onClose={() => setViewing(null)}
      />
    </section>
  );
}

export function SystemStatus() {
  const t = useT();
  return (
    <RequireCapability capability="site:view_system">
      <PageHeader title={t("system.title", "System status")} description={t("system.description", "Health of the platform, background jobs and event delivery.")} />
      <div className="space-y-10">
        <HealthSection />
        <JobsSection />
        <FailedEventsSection />
      </div>
    </RequireCapability>
  );
}
