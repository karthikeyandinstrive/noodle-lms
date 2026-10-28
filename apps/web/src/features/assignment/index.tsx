"use client";

import { AlertTriangle, CalendarClock, CheckCircle2, ClipboardCheck, FileText, Paperclip, Send, Users } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ErrorAlert, HtmlContent, QueryState } from "@/components/common";
import { MultiFileInput } from "@/components/file-input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RichTextEditor } from "@/components/rich-text-editor";
import { errorMessage, fileUrl, type UploadedFile } from "@/lib/api";
import { useFormat, useLocale, useT } from "@/lib/i18n";
import type { ActivityTypeUI, ActivityViewProps, SettingsFieldsProps } from "../activities/types";
import { statusLabel, useMyAssignment, useSaveDraft, useSubmissions, useSubmit, type AssignmentSettings, type MyStatus, type SubmissionStatus } from "./api";
import { DateField, NumberField, SwitchField, formatBytes, relativeTime } from "./form-utils";
import { htmlToPlain, wordCount } from "./text";

const DEFAULTS: AssignmentSettings = {
  instructions: null,
  allowText: true,
  allowFiles: true,
  maxFiles: 5,
  maxFileBytes: 20 * 1024 * 1024,
  acceptedTypes: [],
  dueAt: null,
  cutoffAt: null,
  allowResubmit: true,
  gradeMax: 100,
  gradePass: null,
  blindMarking: false,
};

function settingsOf(activity: ActivityViewProps["activity"]): AssignmentSettings {
  return { ...DEFAULTS, ...((activity.settings ?? {}) as Partial<AssignmentSettings>) };
}

// ─── View ───────────────────────────────────────────────────────────────────

function AssignmentView({ activity, refresh }: ActivityViewProps) {
  const s = settingsOf(activity);
  const caps = activity.capabilities;
  const isGrader = !!caps["assignment:view_submissions"];
  const isLearner = !!caps["assignment:submit"];
  const t = useT();

  return (
    <div className="space-y-6">
      <DatesCard settings={s} />
      {s.instructions && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <FileText className="size-4" aria-hidden /> {t("assignment.instructions", "Instructions")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <HtmlContent html={s.instructions} />
          </CardContent>
        </Card>
      )}
      {isGrader && <TeacherPanel activityId={activity.id} />}
      {isLearner && <StudentPanel activityId={activity.id} settings={s} onChanged={refresh} />}
      {!isGrader && !isLearner && <p className="text-sm text-muted-foreground">{t("assignment.viewOnly", "You are viewing this assignment without being able to submit.")}</p>}
    </div>
  );
}

function DatesCard({ settings }: { settings: AssignmentSettings }) {
  const t = useT();
  const fmt = useFormat();
  const locale = useLocale();
  if (!settings.dueAt && !settings.cutoffAt) return null;
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-2 rounded-xl border bg-muted/30 p-4 text-sm">
      {settings.dueAt && (
        <div className="flex items-center gap-2">
          <CalendarClock className="size-4 text-muted-foreground" aria-hidden />
          <span>
            <span className="font-medium">{t("assignment.dueLabel", "Due:")}</span> {fmt.date(settings.dueAt)}{" "}
            <span className="text-muted-foreground">({relativeTime(settings.dueAt, locale)})</span>
          </span>
        </div>
      )}
      {settings.cutoffAt && (
        <div className="flex items-center gap-2">
          <AlertTriangle className="size-4 text-muted-foreground" aria-hidden />
          <span>
            <span className="font-medium">{t("assignment.cutoffLabel", "Cut-off:")}</span> {fmt.date(settings.cutoffAt)}
          </span>
        </div>
      )}
    </div>
  );
}

function TeacherPanel({ activityId }: { activityId: string }) {
  const q = useSubmissions(activityId);
  const t = useT();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Users className="size-4" aria-hidden /> {t("assignment.submissions", "Submissions")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <QueryState query={q}>
          {q.data && (
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                [t("assignment.participants", "Participants"), q.data.counts.participants],
                [t("assignment.status.submitted", "Submitted"), q.data.counts.submitted],
                [t("assignment.needsGrading", "Needs grading"), q.data.counts.needsGrading],
                [t("assignment.status.graded", "Graded"), q.data.counts.graded],
              ].map(([label, n]) => (
                <div key={label} className="rounded-lg border p-3">
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd className="text-xl font-semibold">{n}</dd>
                </div>
              ))}
            </dl>
          )}
        </QueryState>
        <Link href={`/activities/${activityId}/assignment/submissions`} className={buttonVariants()}>
          <ClipboardCheck aria-hidden /> {t("assignment.viewAndGrade", "View and grade submissions")}
        </Link>
      </CardContent>
    </Card>
  );
}

export function StatusBadge({ status, late }: { status: SubmissionStatus; late?: boolean }) {
  const t = useT();
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Badge variant={status === "graded" ? "default" : status === "submitted" ? "secondary" : "outline"}>{statusLabel(t, status)}</Badge>
      {late && <Badge variant="destructive">{t("assignment.late", "Late")}</Badge>}
    </span>
  );
}

function StudentPanel({ activityId, settings, onChanged }: { activityId: string; settings: AssignmentSettings; onChanged: () => void }) {
  const q = useMyAssignment(activityId);
  const sub = q.data?.submission;
  return (
    <QueryState query={q}>
      {q.data && (
        // Remount the editor whenever the saved submission changes on the server.
        <StudentPanelBody
          key={`${sub?.id ?? "none"}-${sub?.updatedAt ?? ""}`}
          activityId={activityId}
          settings={settings}
          data={q.data}
          onChanged={onChanged}
        />
      )}
    </QueryState>
  );
}

function StudentPanelBody({
  activityId,
  settings,
  data,
  onChanged,
}: {
  activityId: string;
  settings: AssignmentSettings;
  data: MyStatus;
  onChanged: () => void;
}) {
  const t = useT();
  const fmt = useFormat();
  const save = useSaveDraft(activityId);
  const submit = useSubmit(activityId);
  const sub = data.submission;
  const [text, setText] = useState(() => sub?.text ?? "");
  const [files, setFiles] = useState<UploadedFile[]>(() => (sub?.files ?? []).map((f) => ({ ...f, status: "ready" })));
  const [dirty, setDirty] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const accept = useMemo(() => settings.acceptedTypes.join(","), [settings.acceptedTypes]);
  const empty = !htmlToPlain(text) && files.length === 0;
  const words = wordCount(htmlToPlain(text));

  async function saveDraft(silent = false) {
    await save.mutateAsync({ text: settings.allowText ? text || null : null, fileIds: settings.allowFiles ? files.map((f) => f.id) : [] });
    setDirty(false);
    if (!silent) toast.success(t("assignment.draftSaved", "Draft saved"));
  }

  async function doSubmit() {
    try {
      if (dirty || !sub) await saveDraft(true);
      await submit.mutateAsync();
      toast.success(t("assignment.submittedForGrading", "Submitted for grading"));
      setConfirmOpen(false);
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("assignment.yourSubmission", "Your submission")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">{t("assignment.statusLabel", "Status:")}</span>
            {sub ? <StatusBadge status={sub.status} late={sub.late} /> : <Badge variant="outline">{t("assignment.noSubmission", "No submission")}</Badge>}
            {sub && sub.attempt > 1 && <span className="text-xs text-muted-foreground">{t("assignment.attemptN", "Attempt {n}", { n: sub.attempt })}</span>}
          </div>
          {sub?.submittedAt && <p className="text-muted-foreground">{t("assignment.submittedOn", "Submitted {date}", { date: fmt.date(sub.submittedAt) })}</p>}
          {data.reason && <p className="text-muted-foreground">{data.reason}</p>}

          {!data.canEdit && sub && (
            <div className="space-y-3 border-t pt-3">
              {sub.text && <HtmlContent html={sub.text} className="rounded-lg border bg-muted/20 p-3" />}
              <FileList files={sub.files} />
            </div>
          )}
        </CardContent>
      </Card>

      {data.canEdit && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{sub?.status === "submitted" ? t("assignment.editYourSubmission", "Edit your submission") : t("assignment.workOnSubmission", "Work on your submission")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {sub?.status === "submitted" && (
              <p className="text-sm text-muted-foreground">{t("assignment.changeTurnsDraft", "Changing your work turns it back into a draft — remember to submit again.")}</p>
            )}
            {settings.allowText && (
              <div className="space-y-1.5">
                <Label htmlFor="asg-text">{t("assignment.onlineText", "Online text")}</Label>
                <RichTextEditor
                  id="asg-text"
                  minHeight={220}
                  value={text}
                  onChange={(html) => {
                    setText(html);
                    setDirty(true);
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  {words === 1 ? t("assignment.words.one", "{n} word", { n: words }) : t("assignment.words.other", "{n} words", { n: words })}
                </p>
              </div>
            )}
            {settings.allowFiles && (
              <div className="space-y-1.5">
                <p className="text-sm font-medium">
                  {t("assignment.files", "Files")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {settings.maxFiles === 1
                    ? t("assignment.fileLimit.one", "Up to {n} file, {size} each", { n: settings.maxFiles, size: formatBytes(settings.maxFileBytes) })
                    : t("assignment.fileLimit.other", "Up to {n} files, {size} each", { n: settings.maxFiles, size: formatBytes(settings.maxFileBytes) })}
                  {settings.acceptedTypes.length ? ` · ${settings.acceptedTypes.join(", ")}` : ""}
                </p>
                <MultiFileInput
                  files={files}
                  maxFiles={settings.maxFiles}
                  accept={accept || undefined}
                  onChange={(next) => {
                    const tooBig = next.find((f) => f.size > settings.maxFileBytes);
                    if (tooBig) toast.error(t("assignment.fileTooLarge", "{file} is larger than {size}", { file: tooBig.filename, size: formatBytes(settings.maxFileBytes) }));
                    setFiles(next.filter((f) => f.size <= settings.maxFileBytes));
                    setDirty(true);
                  }}
                />
              </div>
            )}
            {save.isError && <ErrorAlert error={save.error} />}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={save.isPending || (!dirty && !!sub)}
                onClick={() => saveDraft().catch((err) => toast.error(errorMessage(err)))}
              >
                {save.isPending ? t("common.saving", "Saving…") : t("assignment.saveDraft", "Save draft")}
              </Button>
              <Button disabled={empty || submit.isPending || save.isPending} onClick={() => setConfirmOpen(true)}>
                <Send aria-hidden /> {t("assignment.submitForGrading", "Submit for grading")}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("assignment.confirmSubmitTitle", "Submit your work?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {settings.allowResubmit
                ? t("assignment.confirmSubmitResubmit", "You can still change it until it is graded or the cut-off date passes.")
                : t("assignment.confirmSubmitFinal", "Once submitted you cannot make further changes.")}
              {data.dueAt && new Date(data.dueAt) < new Date() && ` ${t("assignment.willBeLate", "This submission will be marked late.")}`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel", "Cancel")}</AlertDialogCancel>
            <AlertDialogAction disabled={submit.isPending} onClick={() => void doSubmit()}>
              {submit.isPending ? t("assignment.submitting", "Submitting…") : t("common.submit", "Submit")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {data.feedback && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CheckCircle2 className="size-4 text-primary" aria-hidden /> {t("assignment.feedback", "Feedback")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>
              <span className="text-muted-foreground">{t("assignment.gradeLabel", "Grade:")}</span> <span className="text-lg font-semibold">{data.feedback.grade ?? "—"}</span>
              <span className="text-muted-foreground"> / {settings.gradeMax}</span>
            </p>
            <p className="text-xs text-muted-foreground">
              {data.feedback.grader
                ? t("assignment.gradedOnBy", "Graded {date} by {name}", {
                    date: fmt.date(data.feedback.gradedAt),
                    name: `${data.feedback.grader.firstName} ${data.feedback.grader.lastName}`,
                  })
                : t("assignment.gradedOn", "Graded {date}", { date: fmt.date(data.feedback.gradedAt) })}
              {sub && data.feedback.attempt !== sub.attempt && ` ${t("assignment.attemptParen", "(attempt {n})", { n: data.feedback.attempt })}`}
            </p>
            <HtmlContent html={data.feedback.feedback} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export function FileList({ files }: { files: { id: string; filename: string; size: number }[] }) {
  if (!files.length) return null;
  return (
    <ul className="space-y-1">
      {files.map((f) => (
        <li key={f.id} className="flex items-center gap-2 text-sm">
          <Paperclip className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <a href={fileUrl(f.id)} target="_blank" rel="noreferrer" className="truncate text-primary hover:underline">
            {f.filename}
          </a>
          <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(f.size)}</span>
        </li>
      ))}
    </ul>
  );
}

// ─── Settings ───────────────────────────────────────────────────────────────

function AssignmentSettingsFields({ value, onChange }: SettingsFieldsProps) {
  const v = { ...DEFAULTS, ...(value as Partial<AssignmentSettings>) };
  const set = <K extends keyof AssignmentSettings>(k: K, val: AssignmentSettings[K]) => onChange({ ...v, [k]: val });
  const [types, setTypes] = useState(v.acceptedTypes.join(", "));
  const t = useT();

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <Label htmlFor="asg-instructions">{t("assignment.instructions", "Instructions")}</Label>
        <RichTextEditor id="asg-instructions" value={v.instructions ?? ""} onChange={(html) => set("instructions", html || null)} />
        <p className="text-xs text-muted-foreground">{t("assignment.instructionsHint", "Shown to students above the submission form.")}</p>
      </div>

      <fieldset className="space-y-3">
        <legend className="mb-2 text-sm font-medium">{t("assignment.submissionTypes", "Submission types")}</legend>
        <SwitchField label={t("assignment.onlineText", "Online text")} checked={v.allowText} onChange={(c) => set("allowText", c)} />
        <SwitchField label={t("assignment.fileSubmissions", "File submissions")} checked={v.allowFiles} onChange={(c) => set("allowFiles", c)} />
        {!v.allowText && !v.allowFiles && <p className="text-xs text-destructive" role="alert">
            {t("assignment.enableOneType", "Enable at least one submission type.")}
          </p>}
        {v.allowFiles && (
          <div className="grid gap-4 sm:grid-cols-3">
            <NumberField
              id="asg-maxfiles"
              label={t("assignment.maxFiles", "Maximum files")}
              min={1}
              max={50}
              step={1}
              value={v.maxFiles}
              onChange={(n) => set("maxFiles", Math.max(1, Math.round(n ?? 1)))}
            />
            <NumberField
              id="asg-maxsize"
              label={t("assignment.maxSizePerFile", "Max size per file (MB)")}
              min={1}
              max={200}
              step={1}
              value={Math.round(v.maxFileBytes / 1024 / 1024)}
              onChange={(n) => set("maxFileBytes", Math.max(1, Math.min(200, n ?? 1)) * 1024 * 1024)}
            />
            <div className="space-y-1.5">
              <Label htmlFor="asg-types">{t("assignment.acceptedTypes", "Accepted types")}</Label>
              <Input
                id="asg-types"
                placeholder=".pdf, .docx"
                value={types}
                onChange={(e) => {
                  setTypes(e.target.value);
                  set(
                    "acceptedTypes",
                    e.target.value
                      .split(",")
                      .map((x) => x.trim())
                      .filter(Boolean),
                  );
                }}
              />
            </div>
          </div>
        )}
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <DateField id="asg-due" label={t("assignment.dueDate", "Due date")}
          value={v.dueAt}
          onChange={(d) => set("dueAt", d)}
          hint={t("assignment.dueDateHint", "Submissions after this are marked late.")}
        />
        <DateField
          id="asg-cutoff"
          label={t("assignment.cutoffDate", "Cut-off date")}
          value={v.cutoffAt}
          onChange={(d) => set("cutoffAt", d)}
          hint={t("assignment.cutoffDateHint", "No submissions are accepted after this.")}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <NumberField id="asg-grademax" label={t("assignment.maxGrade", "Maximum grade")} min={1} value={v.gradeMax} onChange={(n) => set("gradeMax", n ?? 100)} />
        <NumberField id="asg-gradepass" label={t("assignment.gradeToPass", "Grade to pass")} min={0} nullable value={v.gradePass} onChange={(n) => set("gradePass", n)} />
      </div>

      <div className="space-y-3">
        <SwitchField
          label={t("assignment.allowResubmit", "Allow students to change their submission")}
          hint={t("assignment.allowResubmitHint", "Until it is graded or the cut-off date passes.")}
          checked={v.allowResubmit}
          onChange={(c) => set("allowResubmit", c)}
        />
        <SwitchField
          label={t("assignment.blindMarking", "Blind marking")}
          hint={t("assignment.blindMarkingHint", "Graders see “Participant N” instead of names. Turn off to reveal identities.")}
          checked={v.blindMarking}
          onChange={(c) => set("blindMarking", c)}
        />
      </div>
    </div>
  );
}

export const assignmentActivity: ActivityTypeUI = {
  type: "assignment",
  label: "Assignment",
  description: "Students submit work for grading",
  icon: ClipboardCheck,
  defaults: { ...DEFAULTS },
  defaultCompletion: "submit",
  View: AssignmentView,
  SettingsFields: AssignmentSettingsFields,
};
