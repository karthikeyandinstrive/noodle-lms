"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Check, ChevronLeft, ChevronRight, Clock, Flag, Save } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ErrorAlert, QueryState, fullName } from "@/components/common";
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
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, api, errorMessage } from "@/lib/api";
import { useFormat, useLocale, useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { formatDuration, quizKeys, round, useAttempt, type AttemptDetail, type AttemptQuestion, type Response } from "./api";
import { QuestionCard, isAnswered } from "./question-input";

const AUTOSAVE_MS = 2500;

/** Remaining-time thresholds (seconds) at which the countdown is announced to screen readers. */
const TIMER_MILESTONES = [30, 60, 300, 600];

export function QuizAttemptPage() {
  const { activityId, attemptId } = useParams<{ activityId: string; attemptId: string }>();
  const q = useAttempt(activityId, attemptId);
  const d = q.data;

  return (
    <QueryState query={q}>
      {d && (
        <div className="space-y-4">
          <Link href={`/activities/${activityId}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ChevronLeft aria-hidden className="size-4" /> {d.quiz.name}
          </Link>
          {d.attempt.status === "in_progress" && d.isOwner ? (
            <AttemptRunner key={d.attempt.id} data={d} activityId={activityId} />
          ) : (
            <AttemptReview data={d} activityId={activityId} />
          )}
        </div>
      )}
    </QueryState>
  );
}

// ─── Taking the quiz ────────────────────────────────────────────────────────

function AttemptRunner({ data, activityId }: { data: AttemptDetail; activityId: string }) {
  const qc = useQueryClient();
  const t = useT();
  const locale = useLocale();
  const attemptId = data.attempt.id;
  const [responses, setResponses] = useState<Record<string, Response>>(() => Object.fromEntries(data.questions.map((x) => [x.slotId, x.response])));
  const [page, setPage] = useState(0);
  const [saving, setSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const dirty = useRef(new Set<string>());
  const responsesRef = useRef(responses);
  useEffect(() => {
    responsesRef.current = responses;
  }, [responses]);

  // Server clock offset so the countdown is not fooled by a wrong client clock.
  const [offset] = useState(() => new Date(data.attempt.serverNow).getTime() - Date.now());
  const dueAt = data.attempt.dueAt ? new Date(data.attempt.dueAt).getTime() : null;
  const [remaining, setRemaining] = useState(() => (dueAt ? Math.max(0, (dueAt - (Date.now() + offset)) / 1000) : null));

  const reload = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: quizKeys.attempt(activityId, attemptId) });
    await qc.invalidateQueries({ queryKey: quizKeys.summary(activityId) });
  }, [qc, activityId, attemptId]);

  const save = useCallback(async () => {
    const ids = [...dirty.current];
    if (!ids.length) return true;
    dirty.current.clear();
    setSaving(true);
    try {
      await api(`/quizzes/${activityId}/attempts/${attemptId}/responses`, {
        method: "PUT",
        body: { responses: ids.map((slotId) => ({ slotId, response: responsesRef.current[slotId] ?? null })) },
      });
      setLastSaved(new Date());
      return true;
    } catch (err) {
      ids.forEach((id) => dirty.current.add(id));
      if (err instanceof ApiError && err.status === 409) {
        toast.error(err.message);
        await reload();
      } else {
        toast.error(t("quiz.attempt.saveFailed", "Could not save: {error}", { error: errorMessage(err) }));
      }
      return false;
    } finally {
      setSaving(false);
    }
  }, [activityId, attemptId, reload, t]);

  const finish = useCallback(
    async (auto = false) => {
      setFinishing(true);
      try {
        const ids = [...dirty.current];
        await api(`/quizzes/${activityId}/attempts/${attemptId}/finish`, {
          method: "POST",
          body: { responses: ids.map((slotId) => ({ slotId, response: responsesRef.current[slotId] ?? null })) },
        });
        dirty.current.clear();
        toast.success(
          auto ? t("quiz.attempt.timeUpSubmitted", "Time is up — your attempt was submitted") : t("quiz.attempt.submitted", "Attempt submitted"),
        );
      } catch (err) {
        toast.error(errorMessage(err));
      } finally {
        setFinishing(false);
        setConfirm(false);
        await reload();
      }
    },
    [activityId, attemptId, reload, t],
  );

  // Debounced autosave.
  useEffect(() => {
    if (!dirty.current.size) return;
    const timer = setTimeout(() => void save(), AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [responses, save]);

  // Countdown; submits automatically at zero.
  const finishedByTimer = useRef(false);
  useEffect(() => {
    if (!dueAt) return;
    const tick = () => {
      const left = Math.max(0, (dueAt - (Date.now() + offset)) / 1000);
      setRemaining(left);
      if (left <= 0 && !finishedByTimer.current) {
        finishedByTimer.current = true;
        void finish(true);
      }
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [dueAt, offset, finish]);

  // Warn before leaving with unsaved answers.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirty.current.size) e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  const questions = data.questions;
  const current = questions[page]!;
  const unanswered = questions.filter((x) => !isAnswered(responses[x.slotId] ?? null)).length;
  // Announce the countdown only when it crosses a milestone (10, 5, 1 min, 30 s), not every second.
  const milestone = remaining === null ? null : (TIMER_MILESTONES.find((m) => remaining <= m) ?? null);
  const timerAnnouncement =
    milestone === null
      ? ""
      : milestone < 60
        ? t("quiz.attempt.secondsLeft", "{count} seconds left", { count: milestone })
        : milestone === 60
          ? t("quiz.attempt.oneMinuteLeft", "1 minute left")
          : t("quiz.attempt.minutesLeft", "{count} minutes left", { count: milestone / 60 });
  const go = (i: number) => {
    void save();
    setPage(i);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const setResponse = (slotId: string, r: Response) => {
    dirty.current.add(slotId);
    responsesRef.current = { ...responsesRef.current, [slotId]: r };
    setResponses(responsesRef.current);
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_240px]">
      <div className="order-2 space-y-4 lg:order-1">
        {data.attempt.preview && <Badge variant="outline">{t("quiz.attempt.previewNotGraded", "Preview — not graded")}</Badge>}
        <QuestionCard question={current} value={responses[current.slotId] ?? null} onChange={(r) => setResponse(current.slotId, r)} />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button variant="outline" disabled={page === 0} onClick={() => go(page - 1)}>
            <ChevronLeft aria-hidden /> {t("common.previous", "Previous")}
          </Button>
          {page < questions.length - 1 ? (
            <Button onClick={() => go(page + 1)}>
              {t("common.next", "Next")} <ChevronRight aria-hidden />
            </Button>
          ) : (
            <Button onClick={() => void save().then(() => setConfirm(true))}>
              <Flag aria-hidden /> {t("quiz.attempt.finish", "Finish attempt…")}
            </Button>
          )}
        </div>
      </div>

      <aside className="order-1 lg:order-2">
        <Card className="lg:sticky lg:top-4">
          <CardContent className="space-y-4 pt-6">
            {remaining !== null && (
              <>
                {/* The visible clock is not live (role=timer is aria-live=off); milestones are announced below. */}
                <div
                  className={cn(
                    "flex items-center gap-2 rounded-lg border p-2 font-mono text-lg tabular-nums",
                    remaining < 60 && "border-destructive text-destructive",
                  )}
                  role="timer"
                  aria-labelledby="quiz-time-left"
                >
                  <Clock aria-hidden className="size-4" />
                  <span id="quiz-time-left" className="sr-only">
                    {t("quiz.attempt.timeLeft", "Time left")}
                  </span>
                  {formatDuration(remaining)}
                </div>
                <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
                  {timerAnnouncement}
                </p>
              </>
            )}
            <nav aria-label={t("quiz.attempt.questionNav", "Questions")}>
              <ol className="grid grid-cols-6 gap-1.5 sm:grid-cols-10 lg:grid-cols-5">
                {questions.map((x, i) => {
                  const answered = isAnswered(responses[x.slotId] ?? null);
                  return (
                    <li key={x.slotId}>
                      <button
                        type="button"
                        onClick={() => go(i)}
                        aria-current={i === page ? "step" : undefined}
                        aria-label={
                          answered
                            ? t("quiz.attempt.navAnswered", "Question {number}, answered", { number: x.number })
                            : t("quiz.attempt.navUnanswered", "Question {number}, not answered", { number: x.number })
                        }
                        className={cn(
                          "relative flex size-9 items-center justify-center rounded-md border text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                          answered && "bg-muted",
                          i === page && "border-primary font-semibold ring-2 ring-primary/40",
                        )}
                      >
                        {x.number}
                        {answered && <Check aria-hidden className="absolute top-0.5 right-0.5 size-2.5 text-muted-foreground" />}
                      </button>
                    </li>
                  );
                })}
              </ol>
            </nav>
            <p className="text-xs text-muted-foreground">
              {t("quiz.attempt.answeredCount", "{answered} of {total} answered", { answered: questions.length - unanswered, total: questions.length })}
            </p>
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              <Save aria-hidden className="size-3" />
              {saving
                ? t("common.saving", "Saving…")
                : lastSaved
                  ? t("quiz.attempt.savedAt", "Saved {time}", { time: lastSaved.toLocaleTimeString(locale) })
                  : t("quiz.attempt.autosave", "Answers save automatically")}
            </p>
            <Button className="w-full" variant="secondary" onClick={() => void save().then(() => setConfirm(true))}>
              {t("quiz.attempt.finish", "Finish attempt…")}
            </Button>
          </CardContent>
        </Card>
      </aside>

      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("quiz.attempt.confirmTitle", "Submit all and finish?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {unanswered === 0
                ? t("quiz.attempt.allAnswered", "All questions are answered.")
                : unanswered === 1
                  ? t("quiz.attempt.unanswered.one", "{count} question is not answered.", { count: unanswered })
                  : t("quiz.attempt.unanswered.other", "{count} questions are not answered.", { count: unanswered })}{" "}
              {t("quiz.attempt.noChangesAfter", "You will not be able to change your answers after submitting.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("quiz.attempt.return", "Return to attempt")}</AlertDialogCancel>
            <AlertDialogAction disabled={finishing} onClick={() => void finish()}>
              {finishing ? t("quiz.attempt.submitting", "Submitting…") : t("quiz.attempt.submitAll", "Submit all and finish")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ─── Review ─────────────────────────────────────────────────────────────────

function AttemptReview({ data, activityId }: { data: AttemptDetail; activityId: string }) {
  const a = data.attempt;
  const finished = a.status === "finished";
  const t = useT();
  const fmt = useFormat();
  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="grid gap-3 pt-6 text-sm sm:grid-cols-2 lg:grid-cols-4">
          {!data.isOwner && (
            <div>
              <div className="text-xs text-muted-foreground">{t("quiz.student", "Student")}</div>
              <div className="font-medium">{fullName(data.user)}</div>
            </div>
          )}
          <div>
            <div className="text-xs text-muted-foreground">{t("quiz.attempt", "Attempt")}</div>
            <div className="font-medium">{a.preview ? t("quiz.preview", "Preview") : a.attempt}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">{t("quiz.review.startedFinished", "Started / finished")}</div>
            <div className="font-medium">
              {fmt.date(a.startedAt)} / {finished ? fmt.date(a.finishedAt) : t("quiz.review.inProgressLower", "in progress")}
            </div>
          </div>
          {a.sumMarks !== undefined && (
            <div>
              <div className="text-xs text-muted-foreground">{t("quiz.review.marks", "Marks")}</div>
              <div className="font-medium">
                {round(a.sumMarks)} / {round(a.totalMarks)}
              </div>
            </div>
          )}
          {a.grade !== undefined && (
            <div>
              <div className="text-xs text-muted-foreground">{t("quiz.grade", "Grade")}</div>
              <div className="font-medium">{a.needsGrading ? t("quiz.notYetGraded", "Not yet graded") : `${round(a.grade)} / ${a.gradeMax}`}</div>
            </div>
          )}
        </CardContent>
      </Card>
      {!finished && (
        <p className="text-sm text-muted-foreground">
          {t("quiz.review.stillInProgress", "This attempt is still in progress; responses shown are the last saved.")}
        </p>
      )}
      {data.questions.map((x) => (
        <QuestionCard key={x.slotId} question={x} value={x.response} onChange={() => {}} readOnly>
          {data.canGrade && finished && !a.preview && <ManualGrade activityId={activityId} attemptId={a.id} question={x} />}
        </QuestionCard>
      ))}
      <Link href={`/activities/${activityId}`} className={buttonVariants({ variant: "outline" })}>
        {t("quiz.review.backToQuiz", "Back to the quiz")}
      </Link>
    </div>
  );
}

function ManualGrade({ activityId, attemptId, question }: { activityId: string; attemptId: string; question: AttemptQuestion }) {
  const qc = useQueryClient();
  const t = useT();
  const [open, setOpen] = useState(question.state === "needs_grading");
  const [mark, setMark] = useState(question.mark != null ? String(question.mark) : "");
  const [comment, setComment] = useState(question.comment ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const n = Number(mark);
  const invalid = mark.trim() === "" || Number.isNaN(n) || n < 0 || n > question.maxMark;

  if (!open) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        {t("quiz.grade.override", "Override mark / comment")}
      </Button>
    );
  }
  return (
    <form
      className="space-y-3 rounded-lg border border-dashed p-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (invalid) return;
        setPending(true);
        setError(null);
        try {
          await api(`/quizzes/${activityId}/attempts/${attemptId}/slots/${question.slotId}/grade`, { body: { mark: n, comment: comment || null } });
          toast.success(t("quiz.grade.saved", "Mark saved"));
          await qc.invalidateQueries({ queryKey: ["quiz", activityId] });
        } catch (err) {
          setError(err);
        } finally {
          setPending(false);
        }
      }}
    >
      <div className="grid gap-3 sm:grid-cols-[140px_1fr]">
        <div className="space-y-1.5">
          <Label htmlFor={`mark-${question.slotId}`}>{t("quiz.grade.markMax", "Mark (max {max})", { max: question.maxMark })}</Label>
          <Input
            id={`mark-${question.slotId}`}
            type="number"
            min={0}
            max={question.maxMark}
            step="any"
            value={mark}
            aria-invalid={(mark !== "" && invalid) || undefined}
            onChange={(e) => setMark(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`comment-${question.slotId}`}>{t("quiz.grade.comment", "Comment")}</Label>
          <RichTextEditor id={`comment-${question.slotId}`} minHeight={80} value={comment} onChange={setComment} />
        </div>
      </div>
      {error ? <ErrorAlert error={error} /> : null}
      <Button type="submit" size="sm" disabled={pending || invalid}>
        {pending ? t("common.saving", "Saving…") : t("quiz.grade.save", "Save mark")}
      </Button>
    </form>
  );
}
