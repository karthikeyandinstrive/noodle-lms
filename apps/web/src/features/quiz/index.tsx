"use client";

import { BarChart3, Clock, Eye, ListChecks, Pencil, Play } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { HtmlContent, QueryState, formatDate } from "@/components/common";
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
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "@/lib/api";
import type { ActivityTypeUI, ActivityViewProps, SettingsFieldsProps } from "../activities/types";
import { DateField, NumberField, SwitchField, selectClass } from "../assignment/form-utils";
import { GRADE_METHOD_LABEL, formatDuration, round, useQuizSummary, useStartAttempt, type GradeMethod, type QuizSettings } from "./api";

const DEFAULTS: QuizSettings = {
  intro: null,
  openAt: null,
  closeAt: null,
  timeLimitSeconds: null,
  attemptsAllowed: 0,
  gradeMethod: "highest",
  gradeMax: 10,
  gradePass: null,
  shuffleQuestions: false,
  shuffleAnswers: true,
  reviewOptions: { marks: true, correctness: true, feedback: true, rightAnswer: false },
};

// ─── View ───────────────────────────────────────────────────────────────────

function QuizView({ activity }: ActivityViewProps) {
  const q = useQuizSummary(activity.id);
  const start = useStartAttempt(activity.id);
  const router = useRouter();
  const [confirm, setConfirm] = useState(false);
  const caps = activity.capabilities;
  const base = `/activities/${activity.id}/quiz`;

  async function begin() {
    try {
      const r = await start.mutateAsync();
      router.push(`${base}/attempt/${r.attemptId}`);
    } catch (err) {
      toast.error(errorMessage(err));
      setConfirm(false);
    }
  }

  return (
    <QueryState query={q}>
      {q.data && (
        <div className="space-y-6">
          {(caps["activity:update"] || caps["quiz:view_reports"]) && (
            <div className="flex flex-wrap gap-2">
              {caps["activity:update"] && (
                <Button variant="outline" size="sm" render={<Link href={`${base}/edit`} />}>
                  <Pencil /> Edit questions
                </Button>
              )}
              {caps["quiz:view_reports"] && (
                <Button variant="outline" size="sm" render={<Link href={`${base}/results`} />}>
                  <BarChart3 /> Results
                </Button>
              )}
            </div>
          )}

          <HtmlContent html={q.data.intro} />

          <Card>
            <CardContent className="grid gap-3 pt-6 text-sm sm:grid-cols-2">
              <Info label="Questions" value={`${q.data.questionCount} (${round(q.data.totalMarks)} marks)`} />
              <Info label="Time limit" value={q.data.timeLimitSeconds ? formatDuration(q.data.timeLimitSeconds) : "None"} />
              <Info label="Attempts allowed" value={q.data.attemptsAllowed || "Unlimited"} />
              <Info label="Grading method" value={GRADE_METHOD_LABEL[q.data.gradeMethod]} />
              {q.data.openAt && <Info label="Opens" value={formatDate(q.data.openAt)} />}
              {q.data.closeAt && <Info label="Closes" value={formatDate(q.data.closeAt)} />}
              {q.data.gradePass != null && <Info label="Grade to pass" value={`${q.data.gradePass} / ${q.data.gradeMax}`} />}
            </CardContent>
          </Card>

          {q.data.attempts.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Your attempts</CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Attempt</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="hidden sm:table-cell">Finished</TableHead>
                      <TableHead>Grade / {q.data.gradeMax}</TableHead>
                      <TableHead>
                        <span className="sr-only">Actions</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {q.data.attempts.map((a) => (
                      <TableRow key={a.id}>
                        <TableCell>{a.preview ? <Badge variant="outline">Preview</Badge> : a.attempt}</TableCell>
                        <TableCell>{a.status === "in_progress" ? "In progress" : a.needsGrading ? "Awaiting grading" : "Finished"}</TableCell>
                        <TableCell className="hidden sm:table-cell">{formatDate(a.finishedAt)}</TableCell>
                        <TableCell>{a.grade === undefined ? "—" : a.needsGrading ? "Not yet graded" : round(a.grade)}</TableCell>
                        <TableCell className="text-right">
                          <Button variant="ghost" size="sm" render={<Link href={`${base}/attempt/${a.id}`} />}>
                            {a.status === "in_progress" ? "Continue" : "Review"}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {q.data.myGrade !== null && (
                  <p className="mt-3 text-sm">
                    Your grade: <span className="font-semibold">{round(q.data.myGrade)}</span> / {q.data.gradeMax}
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          <div className="flex flex-col items-start gap-2">
            {q.data.inProgressAttemptId ? (
              <Button render={<Link href={`${base}/attempt/${q.data.inProgressAttemptId}`} />}>
                <Play /> Continue your attempt
              </Button>
            ) : q.data.canStart ? (
              <Button onClick={() => (q.data!.timeLimitSeconds ? setConfirm(true) : void begin())} disabled={start.isPending}>
                {q.data.isPreview ? <Eye /> : <Play />}
                {q.data.isPreview ? "Preview quiz" : q.data.attempts.some((a) => !a.preview) ? "Re-attempt quiz" : "Attempt quiz"}
              </Button>
            ) : null}
            {q.data.isPreview && q.data.canStart && <p className="text-xs text-muted-foreground">Previews are not saved to the gradebook.</p>}
            {!q.data.canStart && q.data.reason && <p className="text-sm text-muted-foreground">{q.data.reason}</p>}
          </div>

          <AlertDialog open={confirm} onOpenChange={setConfirm}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle className="flex items-center gap-2">
                  <Clock className="size-4" /> Timed quiz
                </AlertDialogTitle>
                <AlertDialogDescription>
                  You have {formatDuration(q.data.timeLimitSeconds ?? 0)} once you start. The timer keeps running if you leave, and the attempt is submitted
                  automatically when time is up.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction disabled={start.isPending} onClick={() => void begin()}>
                  Start attempt
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      )}
    </QueryState>
  );
}

function Info({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-medium">{value}</div>
    </div>
  );
}

// ─── Settings ───────────────────────────────────────────────────────────────

function QuizSettingsFields({ value, onChange }: SettingsFieldsProps) {
  const v: QuizSettings = { ...DEFAULTS, ...(value as Partial<QuizSettings>) };
  v.reviewOptions = { ...DEFAULTS.reviewOptions, ...(v.reviewOptions ?? {}) };
  const set = <K extends keyof QuizSettings>(k: K, val: QuizSettings[K]) => onChange({ ...v, [k]: val });
  const setReview = (k: keyof QuizSettings["reviewOptions"], val: boolean) => set("reviewOptions", { ...v.reviewOptions, [k]: val });

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <Label htmlFor="quiz-intro">Introduction</Label>
        <Textarea id="quiz-intro" rows={4} value={v.intro ?? ""} onChange={(e) => set("intro", e.target.value || null)} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <DateField id="quiz-open" label="Open the quiz" value={v.openAt} onChange={(d) => set("openAt", d)} />
        <DateField
          id="quiz-close"
          label="Close the quiz"
          value={v.closeAt}
          onChange={(d) => set("closeAt", d)}
          hint="Attempts in progress are submitted at this time."
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <NumberField
          id="quiz-time"
          label="Time limit (minutes)"
          min={0}
          step={1}
          value={v.timeLimitSeconds ? Math.round(v.timeLimitSeconds / 60) : 0}
          onChange={(n) => set("timeLimitSeconds", n && n > 0 ? Math.round(n * 60) : null)}
          hint="0 = no time limit"
        />
        <div className="space-y-1.5">
          <Label htmlFor="quiz-attempts">Attempts allowed</Label>
          <select id="quiz-attempts" className={selectClass} value={v.attemptsAllowed} onChange={(e) => set("attemptsAllowed", Number(e.target.value))}>
            <option value={0}>Unlimited</option>
            {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="quiz-method">Grading method</Label>
          <select id="quiz-method" className={selectClass} value={v.gradeMethod} onChange={(e) => set("gradeMethod", e.target.value as GradeMethod)}>
            {Object.entries(GRADE_METHOD_LABEL).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <NumberField id="quiz-grademax" label="Maximum grade" min={1} value={v.gradeMax} onChange={(n) => set("gradeMax", n ?? 10)} />
        <NumberField id="quiz-gradepass" label="Grade to pass" min={0} nullable value={v.gradePass} onChange={(n) => set("gradePass", n)} />
      </div>

      <div className="space-y-3">
        <SwitchField label="Shuffle question order" checked={v.shuffleQuestions} onChange={(c) => set("shuffleQuestions", c)} />
        <SwitchField label="Shuffle answer options" checked={v.shuffleAnswers} onChange={(c) => set("shuffleAnswers", c)} />
      </div>

      <fieldset className="space-y-3">
        <legend className="mb-1 text-sm font-medium">After an attempt, students can see</legend>
        <SwitchField label="Marks" checked={v.reviewOptions.marks} onChange={(c) => setReview("marks", c)} />
        <SwitchField label="Whether each answer was correct" checked={v.reviewOptions.correctness} onChange={(c) => setReview("correctness", c)} />
        <SwitchField label="Feedback" checked={v.reviewOptions.feedback} onChange={(c) => setReview("feedback", c)} />
        <SwitchField label="The right answers" checked={v.reviewOptions.rightAnswer} onChange={(c) => setReview("rightAnswer", c)} />
      </fieldset>
    </div>
  );
}

export const quizActivity: ActivityTypeUI = {
  type: "quiz",
  label: "Quiz",
  description: "Auto-graded questions from the question bank",
  icon: ListChecks,
  defaults: { ...DEFAULTS, reviewOptions: { ...DEFAULTS.reviewOptions } },
  defaultCompletion: "submit",
  View: QuizView,
  SettingsFields: QuizSettingsFields,
};
