"use client";

import { AlertTriangle, CheckCircle2, Loader2, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useT } from "@/lib/i18n";
import type { BackupRecord, BackupStatus } from "./types";

export function StatusBadge({ status }: { status: BackupStatus }) {
  const t = useT();
  const label = {
    queued: t("backup.status.queued", "Queued"),
    running: t("backup.status.running", "Running"),
    done: t("backup.status.done", "Done"),
    failed: t("backup.status.failed", "Failed"),
  }[status];
  if (status === "done")
    return (
      <Badge variant="secondary">
        <CheckCircle2 aria-hidden /> {label}
      </Badge>
    );
  if (status === "failed")
    return (
      <Badge variant="destructive">
        <XCircle aria-hidden /> {label}
      </Badge>
    );
  return (
    <Badge variant="outline">
      <Loader2 aria-hidden className="animate-spin" /> {label}
    </Badge>
  );
}

/** Counts, warnings and unsupported items recorded by a backup or restore job. */
export function ReportDetails({ record }: { record: BackupRecord }) {
  const t = useT();
  const counts = Object.entries(record.report.counts ?? {}).filter(([k, v]) => v > 0 && !k.includes("."));
  const warnings = record.report.warnings ?? [];
  const unsupported = record.report.unsupported ?? [];
  const countLabel = (k: string) =>
    ({
      sections: t("backup.count.sections", "Sections"),
      activities: t("backup.count.activities", "Activities"),
      questions: t("backup.count.questions", "Questions"),
      quizSlots: t("backup.count.quizSlots", "Quiz questions"),
      gradeItems: t("backup.count.gradeItems", "Grade items"),
      groups: t("backup.count.groups", "Groups"),
      badges: t("backup.count.badges", "Badges"),
      files: t("backup.count.files", "Files"),
      users: t("backup.count.users", "Users"),
      enrolments: t("backup.count.enrolments", "Enrolments"),
      certificateTemplates: t("backup.count.templates", "Certificate templates"),
      attendanceSessions: t("backup.count.sessions", "Attendance sessions"),
    })[k] ?? k;
  return (
    <div className="space-y-3 text-sm">
      {record.error && <p className="text-destructive">{record.error}</p>}
      {counts.length > 0 && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
          {counts.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-2 border-b py-0.5">
              <dt className="text-muted-foreground">{countLabel(k)}</dt>
              <dd className="font-medium tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {warnings.length > 0 && (
        <div>
          <p className="mb-1 flex items-center gap-1.5 font-medium">
            <AlertTriangle aria-hidden className="size-4 text-amber-500" /> {t("backup.warnings", "Warnings ({count})", { count: warnings.length })}
          </p>
          <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      {unsupported.length > 0 && (
        <div>
          <p className="mb-1 font-medium">{t("backup.unsupported", "Not restored")}</p>
          <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
            {unsupported.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
