"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Download, HardDriveDownload } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { EmptyState, QueryState } from "@/components/common";
import { buttonVariants, Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { useCourse } from "@/features/courses/use-course";
import { api, errorMessage, fileUrl } from "@/lib/api";
import { useFormat, useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { ReportDetails, StatusBadge } from "./shared";
import { formatBytes, isPending, type BackupRecord } from "./types";

const POLL_MS = 3000;

/** /courses/[courseId]/backup — create backups and download finished archives. */
export function CourseBackup() {
  const t = useT();
  const fmt = useFormat();
  const qc = useQueryClient();
  const course = useCourse();
  const courseId = course.courseId;
  const [includeFiles, setIncludeFiles] = useState(true);
  const [includeUserData, setIncludeUserData] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const key = ["backups", courseId] as const;

  const list = useQuery({
    queryKey: key,
    queryFn: () => api<BackupRecord[]>("/backups", { query: { courseId } }),
    enabled: course.can("course:backup"),
    // Poll while a job is in progress.
    refetchInterval: (q) => (q.state.data?.some(isPending) ? POLL_MS : false),
  });

  const create = useMutation({
    mutationFn: () => api<BackupRecord>(`/backups/courses/${courseId}`, { body: { includeFiles, includeUserData } }),
    onSuccess: () => {
      toast.success(t("backup.started", "Backup started. You'll be notified when it is ready."));
      qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (course.data && !course.can("course:backup")) {
    return <EmptyState title={t("backup.noPermission", "You don't have permission to back up this course.")} />;
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t("backup.createTitle", "Create a backup")}</CardTitle>
          <CardDescription>
            {t("backup.createHelp", "Exports sections, activities with all their settings, the question bank, gradebook setup, groups and badges as a .zip you can restore into a new course.")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <div className="flex items-start gap-2">
              <Checkbox id="backup-files" checked={includeFiles} onCheckedChange={(v) => setIncludeFiles(!!v)} />
              <div className="grid gap-0.5">
                <Label htmlFor="backup-files">{t("backup.includeFiles", "Include files")}</Label>
                <p className="text-xs text-muted-foreground">{t("backup.includeFilesHelp", "Course images, file resources, H5P/SCORM packages and embedded images.")}</p>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <Checkbox id="backup-users" checked={includeUserData} onCheckedChange={(v) => setIncludeUserData(!!v)} />
              <div className="grid gap-0.5">
                <Label htmlFor="backup-users">{t("backup.includeUserData", "Include user data")}</Label>
                <p className="text-xs text-muted-foreground">
                  {t("backup.includeUserDataHelp", "Enrolments (with emails), grades, submission details and forum posts. Contains personal data: store the archive safely.")}
                </p>
              </div>
            </div>
            <Button type="submit" disabled={create.isPending}>
              <HardDriveDownload aria-hidden /> {t("backup.create", "Back up now")}
            </Button>
          </form>
        </CardContent>
      </Card>

      <section aria-labelledby="backup-list-title">
        <h2 id="backup-list-title" className="mb-3 text-lg font-semibold">
          {t("backup.listTitle", "Backups")}
        </h2>
        <QueryState query={list}>
          {!list.data?.length ? (
            <EmptyState title={t("backup.none", "No backups yet")} />
          ) : (
            <ul className="divide-y rounded-xl border">
              {list.data.map((b) => {
                const open = expanded === b.id;
                const opts = b.options as { includeFiles?: boolean; includeUserData?: boolean };
                return (
                  <li key={b.id} className="p-3">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                      <StatusBadge status={b.status} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{b.file?.filename ?? t("backup.inProgress", "Backup in progress…")}</p>
                        <p className="text-xs text-muted-foreground">
                          {fmt.date(b.createdAt)}
                          {b.file ? ` · ${formatBytes(b.file.size)}` : ""}
                          {opts.includeFiles === false ? ` · ${t("backup.noFiles", "without files")}` : ""}
                          {opts.includeUserData ? ` · ${t("backup.withUsers", "with user data")}` : ""}
                        </p>
                      </div>
                      {b.status === "done" && b.fileId && (
                        <a href={fileUrl(b.fileId)} className={buttonVariants({ variant: "outline", size: "sm" })}>
                          <Download aria-hidden /> {t("backup.download", "Download")}
                        </a>
                      )}
                      {(b.status === "done" || b.status === "failed") && (
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-expanded={open}
                          aria-controls={`backup-report-${b.id}`}
                          onClick={() => setExpanded(open ? null : b.id)}
                        >
                          {t("backup.details", "Details")} <ChevronDown aria-hidden className={cn("transition-transform", open && "rotate-180")} />
                        </Button>
                      )}
                    </div>
                    {open && (
                      <div id={`backup-report-${b.id}`} className="mt-3">
                        <ReportDetails record={b} />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </QueryState>
      </section>
    </div>
  );
}
