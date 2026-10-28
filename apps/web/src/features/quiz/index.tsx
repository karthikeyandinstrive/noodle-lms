"use client";

import { BarChart3, Clock, Eye, ListChecks, Pencil, Play } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { HtmlContent, QueryState } from "@/components/common";
import { RichTextEditor } from "@/components/rich-text-editor";
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
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { errorMessage } from "@/lib/api";
import { useFormat, useT } from "@/lib/i18n";
import type { ActivityTypeUI, ActivityViewProps, SettingsFieldsProps } from "../activities/types";
import { DateField, NumberField, SwitchField, selectClass } from "../assignment/form-utils";
import { GRADE_METHOD_LABEL, formatDuration, gradeMethodLabel, round, useQuizSummary, useStartAttempt, type GradeMethod, type QuizSettings } from "./api";

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
  const t = useT();
  const fmt = useFormat();
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
                <Link href={`${base}/edit`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                  <Pencil aria-hidden /> {t("quiz.editQuestions", "Edit questions")}
                </Link>
              )}
              {caps["quiz:view_reports"] && (
                <Link href={`${base}/results`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                  <BarChart3 aria-hidden /> {t("quiz.results", "Results")}
                </Link>
              )}
            </div>
          )}

          <HtmlContent html={q.data.intro} />

          <Card>
            <CardContent className="grid gap-3 pt-6 text-sm sm:grid-cols-2">
              <Info
                label={t("quiz.questions", "Questions")}
                value={t("quiz.questionsValue", "{count} ({marks} marks)", { count: q.data.questionCount, marks: round(q.data.totalMarks) })}
              />
              <Info
                label={t("quiz.timeLimit", "Time limit")}
                value={q.data.timeLimitSeconds ? formatDuration(q.data.timeLimitSeconds) : t("common.none", "None")}
              />
              <Info label={t("quiz.attemptsAllowed", "Attempts allowed")} value={q.data.attemptsAllowed || t("quiz.unlimited", "Unlimited")} />
              <Info label={t("quiz.gradingMethod", "Grading method")} value={gradeMethodLabel(t, q.data.gradeMethod)} />
              {q.data.openAt && <Info label={t("quiz.opens", "Opens")} value={fmt.date(q.data.openAt)} />}
              {q.data.closeAt && <Info label={t("quiz.closes", "Closes")} value={fmt.date(q.data.closeAt)} />}
              {q.data.gradePass != null && <Info label={t("quiz.gradeToPass", "Grade to pass")} value={`${q.data.gradePass} / ${q.data.gradeMax}`} />}
            </CardContent>
          </Card>

          {q.data.attempts.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  <h2 id="quiz-your-attempts">{t("quiz.yourAttempts", "Your attempts")}</h2>
                </CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <Table aria-labelledby="quiz-your-attempts">
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("quiz.attempt", "Attempt")}</TableHead>
                      <TableHead>{t("common.status", "Status")}</TableHead>
                      <TableHead className="hidden sm:table-cell">{t("quiz.finished", "Finished")}</TableHead>
                      <TableHead>{t("quiz.gradeOutOf", "Grade / {max}", { max: q.data.gradeMax })}</TableHead>
                      <TableHead>
                        <span className="sr-only">{t("common.actions", "Actions")}</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {q.data.attempts.map((a) => (
                      <TableRow key={a.id}>
                        <TableCell>{a.preview ? <Badge variant="outline">{t("quiz.preview", "Preview")}</Badge> : a.attempt}</TableCell>
                        <TableCell>
                          {a.status === "in_progress"
                            ? t("quiz.inProgress", "In progress")
                            : a.needsGrading
                              ? t("quiz.awaitingGrading", "Awaiting grading")
                              : t("quiz.finished", "Finished")}
                        </TableCell>
                        <TableCell className="hidden sm:table-cell">{fmt.date(a.finishedAt)}</TableCell>
                        <TableCell>{a.grade === undefined ? "—" : a.needsGrading ? t("quiz.notYetGraded", "Not yet graded") : round(a.grade)}</TableCell>
                        <TableCell className="text-right">
                          <Link href={`${base}/attempt/${a.id}`} className={buttonVariants({ variant: "ghost", size: "sm" })}>
                            {a.status === "in_progress" ? t("quiz.continue", "Continue") : t("quiz.review", "Review")}
                            <span className="sr-only"> {t("quiz.attemptNumber", "attempt {number}", { number: a.preview ? t("quiz.preview", "Preview") : a.attempt })}</span>
                          </Link>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {q.data.myGrade !== null && (
                  <p className="mt-3 text-sm">
                    {t("quiz.yourGrade", "Your grade:")} <span className="font-semibold">{round(q.data.myGrade)}</span> / {q.data.gradeMax}
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          <div className="flex flex-col items-start gap-2">
            {q.data.inProgressAttemptId ? (
              <Link href={`${base}/attempt/${q.data.inProgressAttemptId}`} className={buttonVariants()}>
                <Play aria-hidden /> {t("quiz.continueAttempt", "Continue your attempt")}
              </Link>
            ) : q.data.canStart ? (
              <Button onClick={() => (q.data!.timeLimitSeconds ? setConfirm(true) : void begin())} disabled={start.isPending}>
                {q.data.isPreview ? <Eye aria-hidden /> : <Play aria-hidden />}
                {q.data.isPreview
                  ? t("quiz.previewQuiz", "Preview quiz")
                  : q.data.attempts.some((a) => !a.preview)
                    ? t("quiz.reattempt", "Re-attempt quiz")
                    : t("quiz.attemptQuiz", "Attempt quiz")}
              </Button>
            ) : null}
            {q.data.isPreview && q.data.canStart && (
              <p className="text-xs text-muted-foreground">{t("quiz.previewNotSaved", "Previews are not saved to the gradebook.")}</p>
            )}
            {!q.data.canStart && q.data.reason && <p className="text-sm text-muted-foreground">{q.data.reason}</p>}
          </div>

          <AlertDialog open={confirm} onOpenChange={setConfirm}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle className="flex items-center gap-2">
                  <Clock aria-hidden className="size-4" /> {t("quiz.timedQuiz", "Timed quiz")}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t(
                    "quiz.timedQuizHint",
                    "You have {duration} once you start. The timer keeps running if you leave, and the attempt is submitted automatically when time is up.",
                    { duration: formatDuration(q.data.timeLimitSeconds ?? 0) },
                  )}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("common.cancel", "Cancel")}</AlertDialogCancel>
                <AlertDialogAction disabled={start.isPending} onClick={() => void begin()}>
                  {t("quiz.startAttempt", "Start attempt")}
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
  const t = useT();

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <Label htmlFor="quiz-intro">{t("quiz.introduction", "Introduction")}</Label>
        <RichTextEditor id="quiz-intro" minHeight={100} value={v.intro ?? ""} onChange={(html) => set("intro", html || null)} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <DateField id="quiz-open" label={t("quiz.openTheQuiz", "Open the quiz")} value={v.openAt} onChange={(d) => set("openAt", d)} />
        <DateField
          id="quiz-close"
          label={t("quiz.closeTheQuiz", "Close the quiz")}
          value={v.closeAt}
          onChange={(d) => set("closeAt", d)}
          hint={t("quiz.closeHint", "Attempts in progress are submitted at this time.")}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <NumberField
          id="quiz-time"
          label={t("quiz.timeLimitMinutes", "Time limit (minutes)")}
          min={0}
          step={1}
          value={v.timeLimitSeconds ? Math.round(v.timeLimitSeconds / 60) : 0}
          onChange={(n) => set("timeLimitSeconds", n && n > 0 ? Math.round(n * 60) : null)}
          hint={t("quiz.timeLimitHint", "0 = no time limit")}
        />
        <div className="space-y-1.5">
          <Label htmlFor="quiz-attempts">{t("quiz.attemptsAllowed", "Attempts allowed")}</Label>
          <select id="quiz-attempts" className={selectClass} value={v.attemptsAllowed} onChange={(e) => set("attemptsAllowed", Number(e.target.value))}>
            <option value={0}>{t("quiz.unlimited", "Unlimited")}</option>
            {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="quiz-method">{t("quiz.gradingMethod", "Grading method")}</Label>
          <select id="quiz-method" className={selectClass} value={v.gradeMethod} onChange={(e) => set("gradeMethod", e.target.value as GradeMethod)}>
            {(Object.keys(GRADE_METHOD_LABEL) as GradeMethod[]).map((k) => (
              <option key={k} value={k}>
                {gradeMethodLabel(t, k)}
              </option>
            ))}
          </select>
        </div>
        <NumberField id="quiz-grademax" label={t("quiz.maximumGrade", "Maximum grade")} min={1} value={v.gradeMax} onChange={(n) => set("gradeMax", n ?? 10)} />
        <NumberField id="quiz-gradepass" label={t("quiz.gradeToPass", "Grade to pass")} min={0} nullable value={v.gradePass} onChange={(n) => set("gradePass", n)} />
      </div>

      <div className="space-y-3">
        <SwitchField label={t("quiz.shuffleQuestions", "Shuffle question order")} checked={v.shuffleQuestions} onChange={(c) => set("shuffleQuestions", c)} />
        <SwitchField label={t("quiz.shuffleAnswers", "Shuffle answer options")} checked={v.shuffleAnswers} onChange={(c) => set("shuffleAnswers", c)} />
      </div>

      <fieldset className="space-y-3">
        <legend className="mb-1 text-sm font-medium">{t("quiz.reviewOptions", "After an attempt, students can see")}</legend>
        <SwitchField label={t("quiz.review.marks", "Marks")} checked={v.reviewOptions.marks} onChange={(c) => setReview("marks", c)} />
        <SwitchField label={t("quiz.review.correctness", "Whether each answer was correct")} checked={v.reviewOptions.correctness} onChange={(c) => setReview("correctness", c)} />
        <SwitchField label={t("quiz.review.feedback", "Feedback")} checked={v.reviewOptions.feedback} onChange={(c) => setReview("feedback", c)} />
        <SwitchField label={t("quiz.review.rightAnswer", "The right answers")} checked={v.reviewOptions.rightAnswer} onChange={(c) => setReview("rightAnswer", c)} />
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
