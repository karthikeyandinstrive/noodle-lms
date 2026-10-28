"use client";

import { useQuery } from "@tanstack/react-query";
import { Package, Paperclip, Play, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { EmptyState, fullName, QueryState } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, errorMessage, uploadFile } from "@/lib/api";
import { useFormat, useT, type Translate } from "@/lib/i18n";
import type { UserSummary } from "@/lib/types";
import type { ActivityTypeUI, ActivityViewProps, SettingsFieldsProps } from "../activities/types";

type ScormSettings = {
  packageFileId: string | null;
  version: "1.2" | "2004";
  title: string | null;
  gradeMax: number;
  gradeMethod: "highest" | "average" | "first" | "last";
  maxAttempts: number;
  scoCount: number;
  multiSco: boolean;
};

type Attempt = {
  id: string;
  attempt: number;
  status: string;
  scoreRaw: number | null;
  scoreMax: number | null;
  scorePercent: number | null;
  totalTimeSeconds: number;
  startedAt: string;
  updatedAt: string;
};

type MyAttempts = { attempts: Attempt[]; gradePercent: number | null; gradeMethod: string; maxAttempts: number; canStartNew: boolean; canAttempt: boolean };
type ReportRow = { user: UserSummary; attempts: number; status: string; gradePercent: number | null; totalTimeSeconds: number; lastAccessAt: string; history: Attempt[] };

const myKey = (id: string) => ["scorm", id, "attempts", "me"] as const;
const reportKey = (id: string) => ["scorm", id, "report"] as const;

function duration(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m ${String(s).padStart(2, "0")}s`;
}

export function statusLabel(t: Translate, status: string) {
  const labels: Record<string, string> = {
    "not attempted": t("scorm.status.notAttempted", "Not attempted"),
    incomplete: t("scorm.status.incomplete", "Incomplete"),
    completed: t("scorm.status.completed", "Completed"),
    passed: t("scorm.status.passed", "Passed"),
    failed: t("scorm.status.failed", "Failed"),
    browsed: t("scorm.status.browsed", "Browsed"),
  };
  return labels[status] ?? status;
}

function StatusBadge({ status }: { status: string }) {
  const t = useT();
  const variant = status === "passed" || status === "completed" ? "default" : status === "failed" ? "destructive" : "outline";
  return <Badge variant={variant}>{statusLabel(t, status)}</Badge>;
}

// ─── View ───────────────────────────────────────────────────────────────────

function MyAttemptsCard({ activityId, canEdit }: { activityId: string; canEdit: boolean }) {
  const t = useT();
  const fmt = useFormat();
  const q = useQuery({ queryKey: myKey(activityId), queryFn: () => api<MyAttempts>(`/scorm/${activityId}/attempts/me`) });
  const player = `/activities/${activityId}/scorm/player`;
  return (
    <QueryState query={q}>
      {q.data && (
        <Card>
          <CardHeader>
            <CardTitle>{t("scorm.yourAttempts", "Your attempts")}</CardTitle>
            <CardDescription>
              {q.data.maxAttempts > 0
                ? t("scorm.attemptsAllowed", "{used} of {max} attempts used", { used: q.data.attempts.length, max: q.data.maxAttempts })
                : t("scorm.attemptsUnlimited", "{used} attempts · unlimited", { used: q.data.attempts.length })}
              {q.data.gradePercent !== null && <> · {t("scorm.grade", "Grade {percent}%", { percent: q.data.gradePercent })}</>}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-2">
              {q.data.canAttempt ? (
                <>
                  <Link href={player} className={buttonVariants()}>
                    <Play aria-hidden /> {q.data.attempts.length ? t("scorm.continue", "Continue") : t("scorm.launch", "Launch")}
                  </Link>
                  {q.data.canStartNew && (
                    <Link href={`${player}?new=1`} className={buttonVariants({ variant: "outline" })}>
                      <RotateCcw aria-hidden /> {t("scorm.newAttempt", "Start a new attempt")}
                    </Link>
                  )}
                </>
              ) : (
                canEdit && (
                  <Link href={player} className={buttonVariants({ variant: "outline" })}>
                    <Play aria-hidden /> {t("scorm.previewButton", "Preview")}
                  </Link>
                )
              )}
            </div>
            {q.data.attempts.length > 0 && (
              <ul className="divide-y rounded-lg border text-sm">
                {q.data.attempts.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                    <span className="font-medium">{t("scorm.attemptN", "Attempt {n}", { n: a.attempt })}</span>
                    <StatusBadge status={a.status} />
                    {a.scorePercent !== null && <span>{a.scorePercent}%</span>}
                    <span className="text-muted-foreground">{duration(a.totalTimeSeconds)}</span>
                    <span className="ml-auto text-xs text-muted-foreground">{fmt.date(a.updatedAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}
    </QueryState>
  );
}

function ReportTable({ activityId }: { activityId: string }) {
  const t = useT();
  const fmt = useFormat();
  const q = useQuery({ queryKey: reportKey(activityId), queryFn: () => api<ReportRow[]>(`/scorm/${activityId}/report`) });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("scorm.report", "Learner attempts")}</CardTitle>
      </CardHeader>
      <CardContent>
        <QueryState query={q}>
          {q.data && !q.data.length && <EmptyState title={t("scorm.reportEmpty", "No attempts yet")} description={t("scorm.reportEmptyHelp", "Attempts appear here when learners open the package.")} />}
          {q.data && q.data.length > 0 && (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("scorm.learner", "Learner")}</TableHead>
                    <TableHead className="text-right">{t("scorm.attempts", "Attempts")}</TableHead>
                    <TableHead>{t("scorm.lastStatus", "Last status")}</TableHead>
                    <TableHead className="text-right">{t("scorm.gradeCol", "Grade")}</TableHead>
                    <TableHead className="text-right">{t("scorm.time", "Time")}</TableHead>
                    <TableHead>{t("scorm.lastAccess", "Last access")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {q.data.map((r) => (
                    <TableRow key={r.user.id}>
                      <TableCell className="font-medium">{fullName(r.user)}</TableCell>
                      <TableCell className="text-right">{r.attempts}</TableCell>
                      <TableCell>
                        <StatusBadge status={r.status} />
                      </TableCell>
                      <TableCell className="text-right">{r.gradePercent === null ? "—" : `${r.gradePercent}%`}</TableCell>
                      <TableCell className="text-right">{duration(r.totalTimeSeconds)}</TableCell>
                      <TableCell>{fmt.date(r.lastAccessAt)}</TableCell>
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
  const t = useT();
  const s = (activity.settings ?? {}) as Partial<ScormSettings>;
  const canAttempt = activity.capabilities["scorm:attempt"] === true;
  const canEdit = activity.capabilities["activity:update"] === true;
  const canReport = activity.capabilities["scorm:view_reports"] === true;
  if (!s.version) return <p className="text-sm text-muted-foreground">{t("scorm.noPackage", "No SCORM package has been uploaded.")}</p>;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 text-sm">
        <Badge variant="outline">SCORM {s.version}</Badge>
        {s.multiSco && <Badge variant="secondary">{t("scorm.multiScoBadge", "{n} SCOs · first one played", { n: s.scoCount ?? 2 })}</Badge>}
      </div>
      {(canAttempt || canEdit) && <MyAttemptsCard activityId={activity.id} canEdit={canEdit} />}
      {canReport && <ReportTable activityId={activity.id} />}
    </div>
  );
}

// ─── Settings ───────────────────────────────────────────────────────────────

/**
 * Package upload. Like FileInput, but sends the zip as application/zip: browsers report
 * .zip files inconsistently (e.g. application/x-zip-compressed on Windows), which the
 * upload API would otherwise reject.
 */
function PackageUpload({ value, onChange }: { value: string | null; onChange: (fileId: string) => void }) {
  const t = useT();
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState<string | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        ref={ref}
        type="file"
        accept=".zip,application/zip"
        className="hidden"
        tabIndex={-1}
        aria-hidden
        onChange={async (e) => {
          const picked = e.target.files?.[0];
          e.target.value = "";
          if (!picked) return;
          if (!/\.zip$/i.test(picked.name)) {
            toast.error(t("scorm.chooseZip", "Choose a .zip file"));
            return;
          }
          setBusy(true);
          try {
            const uploaded = await uploadFile(new File([picked], picked.name, { type: "application/zip" }));
            setName(uploaded.filename);
            onChange(uploaded.id);
          } catch (err) {
            toast.error(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      />
      <Button id="scorm-package" type="button" variant="outline" size="sm" disabled={busy} onClick={() => ref.current?.click()}>
        <Paperclip aria-hidden /> {busy ? t("file.uploading", "Uploading…") : value ? t("scorm.replacePackage", "Replace package") : t("scorm.uploadPackage", "Upload .zip package")}
      </Button>
      <span className="sr-only" role="status" aria-live="polite">
        {busy ? t("file.uploading", "Uploading…") : ""}
      </span>
      {name && <span className="text-sm text-muted-foreground">{name}</span>}
    </div>
  );
}

function SettingsFields({ value, onChange }: SettingsFieldsProps) {
  const t = useT();
  const current = value as Partial<ScormSettings>;
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="scorm-package">{t("scorm.package", "SCORM package")}</Label>
        <PackageUpload value={current.packageFileId ?? null} onChange={(id) => onChange({ ...value, packageFileId: id })} />
        {current.version && (
          <p className="text-xs text-muted-foreground">
            {t("scorm.currentPackage", "Current: {title} (SCORM {version})", { title: current.title ?? "—", version: current.version })}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          {t("scorm.packageHelp", "SCORM 1.2 or 2004 zip with imsmanifest.xml at its root. Packages with several SCOs play only the first one.")}
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="scorm-grade">{t("scorm.gradeMax", "Maximum grade")}</Label>
          <Input
            id="scorm-grade"
            type="number"
            min={0}
            max={10000}
            step="any"
            value={String(current.gradeMax ?? 100)}
            onChange={(e) => onChange({ ...value, gradeMax: e.target.value === "" ? 0 : Number(e.target.value) })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="scorm-method">{t("scorm.gradeMethod", "Grading method")}</Label>
          <select
            id="scorm-method"
            className="h-8 w-full rounded-lg border bg-background px-2 text-sm"
            value={current.gradeMethod ?? "highest"}
            onChange={(e) => onChange({ ...value, gradeMethod: e.target.value })}
          >
            <option value="highest">{t("scorm.method.highest", "Highest attempt")}</option>
            <option value="average">{t("scorm.method.average", "Average of attempts")}</option>
            <option value="first">{t("scorm.method.first", "First attempt")}</option>
            <option value="last">{t("scorm.method.last", "Last attempt")}</option>
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="scorm-attempts">{t("scorm.maxAttempts", "Attempts allowed")}</Label>
          <Input
            id="scorm-attempts"
            type="number"
            min={0}
            max={100}
            step={1}
            aria-describedby="scorm-attempts-help"
            value={String(current.maxAttempts ?? 0)}
            onChange={(e) => onChange({ ...value, maxAttempts: e.target.value === "" ? 0 : Math.max(0, Math.round(Number(e.target.value))) })}
          />
          <p id="scorm-attempts-help" className="text-xs text-muted-foreground">
            {t("scorm.maxAttemptsHelp", "0 = unlimited")}
          </p>
        </div>
      </div>
    </div>
  );
}

export const scormActivity: ActivityTypeUI = {
  type: "scorm",
  label: "SCORM package",
  description: "A SCORM 1.2 or 2004 learning package",
  icon: Package,
  defaults: { gradeMax: 100, gradeMethod: "highest", maxAttempts: 0 },
  defaultCompletion: "submit",
  View,
  SettingsFields,
};
