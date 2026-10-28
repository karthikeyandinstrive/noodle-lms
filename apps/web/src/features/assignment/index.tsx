"use client";

import { AlertTriangle, CalendarClock, CheckCircle2, ClipboardCheck, FileText, Paperclip, Send, Users } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ErrorAlert, HtmlContent, QueryState, formatDate } from "@/components/common";
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
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage, fileUrl, type UploadedFile } from "@/lib/api";
import type { ActivityTypeUI, ActivityViewProps, SettingsFieldsProps } from "../activities/types";
import { STATUS_LABEL, useMyAssignment, useSaveDraft, useSubmissions, useSubmit, type AssignmentSettings, type MyStatus, type SubmissionStatus } from "./api";
import { DateField, NumberField, SwitchField, formatBytes, relativeTime } from "./form-utils";
import { htmlToPlain, plainToHtml, wordCount } from "./text";

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

  return (
    <div className="space-y-6">
      <DatesCard settings={s} />
      {s.instructions && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <FileText className="size-4" /> Instructions
            </CardTitle>
          </CardHeader>
          <CardContent>
            <HtmlContent html={s.instructions} />
          </CardContent>
        </Card>
      )}
      {isGrader && <TeacherPanel activityId={activity.id} />}
      {isLearner && <StudentPanel activityId={activity.id} settings={s} onChanged={refresh} />}
      {!isGrader && !isLearner && <p className="text-sm text-muted-foreground">You are viewing this assignment without being able to submit.</p>}
    </div>
  );
}

function DatesCard({ settings }: { settings: AssignmentSettings }) {
  if (!settings.dueAt && !settings.cutoffAt) return null;
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-2 rounded-xl border bg-muted/30 p-4 text-sm">
      {settings.dueAt && (
        <div className="flex items-center gap-2">
          <CalendarClock className="size-4 text-muted-foreground" />
          <span>
            <span className="font-medium">Due:</span> {formatDate(settings.dueAt)}{" "}
            <span className="text-muted-foreground">({relativeTime(settings.dueAt)})</span>
          </span>
        </div>
      )}
      {settings.cutoffAt && (
        <div className="flex items-center gap-2">
          <AlertTriangle className="size-4 text-muted-foreground" />
          <span>
            <span className="font-medium">Cut-off:</span> {formatDate(settings.cutoffAt)}
          </span>
        </div>
      )}
    </div>
  );
}

function TeacherPanel({ activityId }: { activityId: string }) {
  const q = useSubmissions(activityId);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Users className="size-4" /> Submissions
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <QueryState query={q}>
          {q.data && (
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ["Participants", q.data.counts.participants],
                ["Submitted", q.data.counts.submitted],
                ["Needs grading", q.data.counts.needsGrading],
                ["Graded", q.data.counts.graded],
              ].map(([label, n]) => (
                <div key={label} className="rounded-lg border p-3">
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd className="text-xl font-semibold">{n}</dd>
                </div>
              ))}
            </dl>
          )}
        </QueryState>
        <Button render={<Link href={`/activities/${activityId}/assignment/submissions`} />}>
          <ClipboardCheck /> View and grade submissions
        </Button>
      </CardContent>
    </Card>
  );
}

export function StatusBadge({ status, late }: { status: SubmissionStatus; late?: boolean }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Badge variant={status === "graded" ? "default" : status === "submitted" ? "secondary" : "outline"}>{STATUS_LABEL[status]}</Badge>
      {late && <Badge variant="destructive">Late</Badge>}
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
  const save = useSaveDraft(activityId);
  const submit = useSubmit(activityId);
  const sub = data.submission;
  const [text, setText] = useState(() => htmlToPlain(sub?.text));
  const [files, setFiles] = useState<UploadedFile[]>(() => (sub?.files ?? []).map((f) => ({ ...f, status: "ready" })));
  const [dirty, setDirty] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const accept = useMemo(() => settings.acceptedTypes.join(","), [settings.acceptedTypes]);
  const empty = !text.trim() && files.length === 0;

  async function saveDraft(silent = false) {
    await save.mutateAsync({ text: settings.allowText ? plainToHtml(text) || null : null, fileIds: settings.allowFiles ? files.map((f) => f.id) : [] });
    setDirty(false);
    if (!silent) toast.success("Draft saved");
  }

  async function doSubmit() {
    try {
      if (dirty || !sub) await saveDraft(true);
      await submit.mutateAsync();
      toast.success("Submitted for grading");
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
          <CardTitle className="text-base">Your submission</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">Status:</span>
            {sub ? <StatusBadge status={sub.status} late={sub.late} /> : <Badge variant="outline">No submission</Badge>}
            {sub && sub.attempt > 1 && <span className="text-xs text-muted-foreground">Attempt {sub.attempt}</span>}
          </div>
          {sub?.submittedAt && <p className="text-muted-foreground">Submitted {formatDate(sub.submittedAt)}</p>}
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
            <CardTitle className="text-base">{sub?.status === "submitted" ? "Edit your submission" : "Work on your submission"}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {sub?.status === "submitted" && (
              <p className="text-sm text-muted-foreground">Changing your work turns it back into a draft — remember to submit again.</p>
            )}
            {settings.allowText && (
              <div className="space-y-1.5">
                <Label htmlFor="asg-text">Online text</Label>
                <Textarea
                  id="asg-text"
                  rows={10}
                  value={text}
                  onChange={(e) => {
                    setText(e.target.value);
                    setDirty(true);
                  }}
                />
                <p className="text-xs text-muted-foreground">{wordCount(text)} words</p>
              </div>
            )}
            {settings.allowFiles && (
              <div className="space-y-1.5">
                <Label>Files</Label>
                <p className="text-xs text-muted-foreground">
                  Up to {settings.maxFiles} file{settings.maxFiles > 1 ? "s" : ""}, {formatBytes(settings.maxFileBytes)} each
                  {settings.acceptedTypes.length ? ` · ${settings.acceptedTypes.join(", ")}` : ""}
                </p>
                <MultiFileInput
                  files={files}
                  maxFiles={settings.maxFiles}
                  accept={accept || undefined}
                  onChange={(next) => {
                    const tooBig = next.find((f) => f.size > settings.maxFileBytes);
                    if (tooBig) toast.error(`${tooBig.filename} is larger than ${formatBytes(settings.maxFileBytes)}`);
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
                {save.isPending ? "Saving…" : "Save draft"}
              </Button>
              <Button disabled={empty || submit.isPending || save.isPending} onClick={() => setConfirmOpen(true)}>
                <Send /> Submit for grading
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Submit your work?</AlertDialogTitle>
            <AlertDialogDescription>
              {settings.allowResubmit
                ? "You can still change it until it is graded or the cut-off date passes."
                : "Once submitted you cannot make further changes."}
              {data.dueAt && new Date(data.dueAt) < new Date() && " This submission will be marked late."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={submit.isPending} onClick={() => void doSubmit()}>
              {submit.isPending ? "Submitting…" : "Submit"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {data.feedback && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CheckCircle2 className="size-4 text-primary" /> Feedback
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>
              <span className="text-muted-foreground">Grade:</span> <span className="text-lg font-semibold">{data.feedback.grade ?? "—"}</span>
              <span className="text-muted-foreground"> / {settings.gradeMax}</span>
            </p>
            <p className="text-xs text-muted-foreground">
              Graded {formatDate(data.feedback.gradedAt)}
              {data.feedback.grader && ` by ${data.feedback.grader.firstName} ${data.feedback.grader.lastName}`}
              {sub && data.feedback.attempt !== sub.attempt && ` (attempt ${data.feedback.attempt})`}
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
          <Paperclip className="size-3.5 shrink-0 text-muted-foreground" />
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

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <Label htmlFor="asg-instructions">Instructions</Label>
        <Textarea id="asg-instructions" rows={5} value={v.instructions ?? ""} onChange={(e) => set("instructions", e.target.value || null)} />
        <p className="text-xs text-muted-foreground">Shown to students above the submission form. Basic HTML is allowed.</p>
      </div>

      <fieldset className="space-y-3">
        <legend className="mb-2 text-sm font-medium">Submission types</legend>
        <SwitchField label="Online text" checked={v.allowText} onChange={(c) => set("allowText", c)} />
        <SwitchField label="File submissions" checked={v.allowFiles} onChange={(c) => set("allowFiles", c)} />
        {!v.allowText && !v.allowFiles && <p className="text-xs text-destructive">Enable at least one submission type.</p>}
        {v.allowFiles && (
          <div className="grid gap-4 sm:grid-cols-3">
            <NumberField
              id="asg-maxfiles"
              label="Maximum files"
              min={1}
              max={50}
              step={1}
              value={v.maxFiles}
              onChange={(n) => set("maxFiles", Math.max(1, Math.round(n ?? 1)))}
            />
            <NumberField
              id="asg-maxsize"
              label="Max size per file (MB)"
              min={1}
              max={200}
              step={1}
              value={Math.round(v.maxFileBytes / 1024 / 1024)}
              onChange={(n) => set("maxFileBytes", Math.max(1, Math.min(200, n ?? 1)) * 1024 * 1024)}
            />
            <div className="space-y-1.5">
              <Label htmlFor="asg-types">Accepted types</Label>
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
                      .map((t) => t.trim())
                      .filter(Boolean),
                  );
                }}
              />
            </div>
          </div>
        )}
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <DateField id="asg-due" label="Due date" value={v.dueAt} onChange={(d) => set("dueAt", d)} hint="Submissions after this are marked late." />
        <DateField
          id="asg-cutoff"
          label="Cut-off date"
          value={v.cutoffAt}
          onChange={(d) => set("cutoffAt", d)}
          hint="No submissions are accepted after this."
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <NumberField id="asg-grademax" label="Maximum grade" min={1} value={v.gradeMax} onChange={(n) => set("gradeMax", n ?? 100)} />
        <NumberField id="asg-gradepass" label="Grade to pass" min={0} nullable value={v.gradePass} onChange={(n) => set("gradePass", n)} />
      </div>

      <div className="space-y-3">
        <SwitchField
          label="Allow students to change their submission"
          hint="Until it is graded or the cut-off date passes."
          checked={v.allowResubmit}
          onChange={(c) => set("allowResubmit", c)}
        />
        <SwitchField
          label="Blind marking"
          hint="Graders see “Participant N” instead of names. Turn off to reveal identities."
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
