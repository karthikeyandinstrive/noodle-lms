"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArchiveRestore, Paperclip, X } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { EmptyState, PageHeader, QueryState } from "@/components/common";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, errorMessage, uploadFile, type UploadedFile } from "@/lib/api";
import { useFormat, useT } from "@/lib/i18n";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { ReportDetails, StatusBadge } from "./shared";
import { formatBytes, isPending, type BackupRecord } from "./types";

const POLL_MS = 3000;
const selectClass = "h-8 w-full rounded-lg border bg-background px-2 text-sm";

type Category = { id: string; parentId: string | null; name: string };

/**
 * Like the shared FileInput, but for backup archives: browsers report no MIME type
 * for .mbz files, so they are uploaded as application/zip (the server inspects the
 * bytes and accepts both ZIP and gzip-compressed tar).
 */
function ArchiveInput({ value, onChange }: { value: UploadedFile | null; onChange: (f: UploadedFile | null) => void }) {
  const t = useT();
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        ref={ref}
        type="file"
        accept=".zip,.mbz,application/zip"
        className="hidden"
        tabIndex={-1}
        aria-hidden
        onChange={async (e) => {
          const picked = e.target.files?.[0];
          e.target.value = "";
          if (!picked) return;
          if (!/\.(zip|mbz)$/i.test(picked.name)) {
            toast.error(t("restore.wrongType", "Choose a .zip backup or a Moodle .mbz file"));
            return;
          }
          setBusy(true);
          try {
            const file = new File([picked], picked.name, { type: "application/zip" });
            onChange(await uploadFile(file));
          } catch (err) {
            toast.error(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      />
      <Button id="restore-file" type="button" variant="outline" size="sm" disabled={busy} onClick={() => ref.current?.click()}>
        <Paperclip aria-hidden /> {busy ? t("file.uploading", "Uploading…") : value ? t("file.replace", "Replace file") : t("file.choose", "Choose file")}
      </Button>
      <span className="sr-only" role="status" aria-live="polite">
        {busy ? t("file.uploading", "Uploading…") : ""}
      </span>
      {value && (
        <>
          <span className="max-w-56 truncate text-sm">
            {value.filename} <span className="text-muted-foreground">({formatBytes(value.size)})</span>
          </span>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={t("file.remove", "Remove file")} onClick={() => onChange(null)}>
            <X />
          </Button>
        </>
      )}
    </div>
  );
}

/** Categories as an indented list (parents first). */
function flattenCategories(cats: Category[]) {
  const out: { id: string; label: string }[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const c of cats.filter((x) => x.parentId === parentId)) {
      out.push({ id: c.id, label: `${"— ".repeat(depth)}${c.name}` });
      if (depth < 10) walk(c.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** /admin/restore — upload a backup and restore it as a new course. */
export function RestorePage() {
  const t = useT();
  const fmt = useFormat();
  const qc = useQueryClient();
  const session = useSession();
  const focusId = useSearchParams().get("id");
  const [file, setFile] = useState<UploadedFile | null>(null);
  const [categoryId, setCategoryId] = useState("");
  const [fullname, setFullname] = useState("");
  const [shortname, setShortname] = useState("");
  const [restoreEnrolments, setRestoreEnrolments] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(focusId);
  const canRestore = session.can("course:restore");

  const categories = useQuery({ queryKey: ["categories"], queryFn: () => api<Category[]>("/categories"), enabled: canRestore });
  const list = useQuery({
    queryKey: ["backups", "restores"],
    queryFn: () => api<BackupRecord[]>("/backups"),
    enabled: canRestore,
    refetchInterval: (q) => (q.state.data?.some(isPending) ? POLL_MS : false),
  });

  const restore = useMutation({
    mutationFn: () =>
      api<BackupRecord>("/backups/restore", {
        body: {
          fileId: file!.id,
          categoryId: categoryId || null,
          fullname: fullname.trim() || undefined,
          shortname: shortname.trim() || undefined,
          restoreEnrolments,
        },
      }),
    onSuccess: (r) => {
      toast.success(t("restore.started", "Restore started. The new course will appear when it finishes."));
      setFile(null);
      setFullname("");
      setShortname("");
      setExpanded(r.id);
      qc.invalidateQueries({ queryKey: ["backups", "restores"] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (session.data && !canRestore) {
    return <EmptyState title={t("restore.noPermission", "You don't have permission to restore courses.")} />;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("restore.title", "Restore a course")}
        description={t("restore.description", "Create a new course from a backup made on this platform (.zip) or a Moodle backup (.mbz, best effort).")}
      />
      <Card>
        <CardHeader>
          <CardTitle>{t("restore.uploadTitle", "Upload a backup")}</CardTitle>
          <CardDescription>
            {t("restore.uploadHelp", "Restoring never changes existing courses. Moodle imports bring sections, pages, links, labels, assignments, forums and (empty) quizzes.")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-4 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (file) restore.mutate();
            }}
          >
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="restore-file">{t("restore.file", "Backup file")}</Label>
              <ArchiveInput value={file} onChange={setFile} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="restore-category">{t("restore.category", "Category")}</Label>
              <select id="restore-category" className={selectClass} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                <option value="">{t("restore.noCategory", "No category (site level)")}</option>
                {flattenCategories(categories.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="hidden sm:block" />
            <div className="space-y-1.5">
              <Label htmlFor="restore-fullname">{t("restore.fullname", "Course name (optional)")}</Label>
              <Input id="restore-fullname" value={fullname} maxLength={255} onChange={(e) => setFullname(e.target.value)} placeholder={t("restore.keepName", "Keep the name in the backup")} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="restore-shortname">{t("restore.shortname", "Short name (optional)")}</Label>
              <Input id="restore-shortname" value={shortname} maxLength={100} onChange={(e) => setShortname(e.target.value)} placeholder={t("restore.keepName", "Keep the name in the backup")} />
            </div>
            <div className="flex items-start gap-2 sm:col-span-2">
              <Checkbox id="restore-enrol" checked={restoreEnrolments} onCheckedChange={(v) => setRestoreEnrolments(!!v)} />
              <div className="grid gap-0.5">
                <Label htmlFor="restore-enrol">{t("restore.enrolments", "Restore enrolments")}</Label>
                <p className="text-xs text-muted-foreground">
                  {t("restore.enrolmentsHelp", "Only for backups with user data: enrols people who already have an account with the same email here. Grades and submissions are not restored.")}
                </p>
              </div>
            </div>
            <div className="sm:col-span-2">
              <Button type="submit" disabled={!file || restore.isPending}>
                <ArchiveRestore aria-hidden /> {t("restore.submit", "Restore as new course")}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <section aria-labelledby="restore-list-title">
        <h2 id="restore-list-title" className="mb-3 text-lg font-semibold">
          {t("restore.listTitle", "Restores")}
        </h2>
        <QueryState query={list}>
          {!list.data?.length ? (
            <EmptyState title={t("restore.none", "No restores yet")} />
          ) : (
            <ul className="divide-y rounded-xl border">
              {list.data.map((r) => {
                const open = expanded === r.id;
                return (
                  <li key={r.id} className={cn("p-3", r.id === focusId && "bg-muted/40")}>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                      <StatusBadge status={r.status} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                          {r.course?.fullname ?? r.report.source?.course ?? r.file?.filename ?? t("restore.pending", "Restoring…")}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {fmt.date(r.createdAt)}
                          {r.file ? ` · ${r.file.filename}` : ""}
                          {r.report.source?.format === "moodle" ? ` · ${t("restore.fromMoodle", "Moodle import")}` : ""}
                        </p>
                      </div>
                      {r.status === "done" && r.course && (
                        <Link href={`/courses/${r.course.id}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                          {t("restore.openCourse", "Open course")}
                        </Link>
                      )}
                      {!isPending(r) && (
                        <Button variant="ghost" size="sm" aria-expanded={open} aria-controls={`restore-report-${r.id}`} onClick={() => setExpanded(open ? null : r.id)}>
                          {open ? t("restore.hideReport", "Hide report") : t("restore.showReport", "Report")}
                        </Button>
                      )}
                    </div>
                    {open && !isPending(r) && (
                      <div id={`restore-report-${r.id}`} className="mt-3">
                        <ReportDetails record={r} />
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
