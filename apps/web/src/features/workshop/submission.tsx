"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Paperclip } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ErrorAlert, HtmlContent } from "@/components/common";
import { MultiFileInput } from "@/components/file-input";
import { RichTextEditor } from "@/components/rich-text-editor";
import { activityKey } from "@/features/activities/use-activity";
import { api, fileUrl, type UploadedFile } from "@/lib/api";
import { useFormat, useT } from "@/lib/i18n";
import { htmlToPlain } from "../assignment/text";
import { workshopKeys, type FileSummary, type Submission } from "./api";

export function FileList({ files }: { files: FileSummary[] }) {
  if (!files.length) return null;
  return (
    <ul className="space-y-1">
      {files.map((f) => (
        <li key={f.id} className="flex items-center gap-2 text-sm">
          <Paperclip className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <a href={fileUrl(f.id)} target="_blank" rel="noreferrer" className="truncate text-primary hover:underline">
            {f.filename}
          </a>
        </li>
      ))}
    </ul>
  );
}

export function SubmissionCard({ submission, title }: { submission: Submission | Omit<Submission, "grade" | "gradeOverride">; title?: string }) {
  const t = useT();
  const fmt = useFormat();
  return (
    <Card>
      <CardHeader>
        <CardDescription>{title ?? t("workshop.yourSubmission", "Your submission")}</CardDescription>
        <CardTitle className="break-words">{submission.title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <HtmlContent html={submission.content} className="break-words" />
        <FileList files={submission.files} />
        <p className="text-xs text-muted-foreground">{t("workshop.lastSaved", "Last saved {date}", { date: fmt.date(submission.updatedAt ?? submission.createdAt) })}</p>
      </CardContent>
    </Card>
  );
}

export function SubmissionForm({ activityId, existing, deadline }: { activityId: string; existing: Submission | null; deadline: string | null }) {
  const qc = useQueryClient();
  const t = useT();
  const fmt = useFormat();
  const [editing, setEditing] = useState(!existing);
  const [title, setTitle] = useState(existing?.title ?? "");
  const [content, setContent] = useState(() => existing?.content ?? "");
  const hasText = !!htmlToPlain(content);
  const [files, setFiles] = useState<UploadedFile[]>(() => (existing?.files ?? []).map((f) => ({ ...f, status: "ready" })));

  const save = useMutation({
    mutationFn: () =>
      api<Submission>(`/workshops/${activityId}/submission`, {
        method: "PUT",
        body: { title: title.trim(), content: hasText ? content : null, fileIds: files.map((f) => f.id) },
      }),
    onSuccess: async () => {
      toast.success(t("workshop.submissionSaved", "Submission saved"));
      setEditing(false);
      await qc.invalidateQueries({ queryKey: workshopKeys.overview(activityId) });
      await qc.invalidateQueries({ queryKey: activityKey(activityId) });
    },
  });

  if (existing && !editing) {
    return (
      <div className="space-y-3">
        <SubmissionCard submission={existing} />
        <Button variant="outline" onClick={() => setEditing(true)}>
          {t("workshop.editSubmission", "Edit submission")}
        </Button>
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{existing ? t("workshop.editYourSubmission", "Edit your submission") : t("workshop.submitYourWork", "Submit your work")}</CardTitle>
        {deadline && <CardDescription>{t("workshop.dueOn", "Due {date}", { date: fmt.date(deadline) })}</CardDescription>}
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          {save.isError && <ErrorAlert error={save.error} />}
          <div className="space-y-1.5">
            <Label htmlFor="ws-title">{t("workshop.title", "Title")}</Label>
            <Input id="ws-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={255} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ws-content">{t("workshop.text", "Text")}</Label>
            <RichTextEditor id="ws-content" minHeight={220} value={content} onChange={setContent} />
          </div>
          <div className="space-y-1.5">
            <span className="text-sm font-medium">{t("workshop.files", "Files")}</span>
            <MultiFileInput files={files} onChange={setFiles} maxFiles={20} />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={save.isPending || !title.trim() || (!hasText && !files.length)}>
              {save.isPending ? t("common.saving", "Saving…") : existing ? t("workshop.saveChanges", "Save changes") : t("common.submit", "Submit")}
            </Button>
            {existing && (
              <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
                {t("common.cancel", "Cancel")}
              </Button>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
