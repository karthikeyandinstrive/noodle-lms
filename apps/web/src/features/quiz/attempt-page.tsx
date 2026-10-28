"use client";

import { useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Clock, Flag, Save } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ErrorAlert, QueryState, formatDate } from "@/components/common";
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
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import { htmlToPlain } from "../assignment/text";
import { formatDuration, quizKeys, round, useAttempt, type AttemptDetail, type AttemptQuestion, type Response } from "./api";
import { QuestionCard, isAnswered } from "./question-input";

const AUTOSAVE_MS = 2500;

export function QuizAttemptPage() {
  const { activityId, attemptId } = useParams<{ activityId: string; attemptId: string }>();
  const q = useAttempt(activityId, attemptId);
  const d = q.data;

  return (
    <QueryState query={q}>
      {d && (
        <div className="space-y-4">
          <Link href={`/activities/${activityId}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ChevronLeft className="size-4" /> {d.quiz.name}
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
        toast.error(`Could not save: ${errorMessage(err)}`);
      }
      return false;
    } finally {
      setSaving(false);
    }
  }, [activityId, attemptId, reload]);

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
        toast.success(auto ? "Time is up — your attempt was submitted" : "Attempt submitted");
      } catch (err) {
        toast.error(errorMessage(err));
      } finally {
        setFinishing(false);
        setConfirm(false);
        await reload();
      }
    },
    [activityId, attemptId, reload],
  );

  // Debounced autosave.
  useEffect(() => {
    if (!dirty.current.size) return;
    const t = setTimeout(() => void save(), AUTOSAVE_MS);
    return () => clearTimeout(t);
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
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
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
        {data.attempt.preview && <Badge variant="outline">Preview — not graded</Badge>}
        <QuestionCard question={current} value={responses[current.slotId] ?? null} onChange={(r) => setResponse(current.slotId, r)} />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button variant="outline" disabled={page === 0} onClick={() => go(page - 1)}>
            <ChevronLeft /> Previous
          </Button>
          {page < questions.length - 1 ? (
            <Button onClick={() => go(page + 1)}>
              Next <ChevronRight />
            </Button>
          ) : (
            <Button onClick={() => void save().then(() => setConfirm(true))}>
              <Flag /> Finish attempt…
            </Button>
          )}
        </div>
      </div>

      <aside className="order-1 lg:order-2">
        <Card className="lg:sticky lg:top-4">
          <CardContent className="space-y-4 pt-6">
            {remaining !== null && (
              <div
                className={cn(
                  "flex items-center gap-2 rounded-lg border p-2 font-mono text-lg tabular-nums",
                  remaining < 60 && "border-destructive text-destructive",
                )}
                role="timer"
                aria-live={remaining < 60 ? "assertive" : "off"}
                aria-label={`Time left ${formatDuration(remaining)}`}
              >
                <Clock className="size-4" /> {formatDuration(remaining)}
              </div>
            )}
            <nav aria-label="Questions">
              <ol className="grid grid-cols-6 gap-1.5 sm:grid-cols-10 lg:grid-cols-5">
                {questions.map((x, i) => (
                  <li key={x.slotId}>
                    <button
                      type="button"
                      onClick={() => go(i)}
                      aria-current={i === page ? "step" : undefined}
                      aria-label={`Question ${x.number}${isAnswered(responses[x.slotId] ?? null) ? ", answered" : ""}`}
                      className={cn(
                        "flex size-9 items-center justify-center rounded-md border text-sm",
                        isAnswered(responses[x.slotId] ?? null) && "bg-muted",
                        i === page && "border-primary ring-2 ring-primary/40",
                      )}
                    >
                      {x.number}
                    </button>
                  </li>
                ))}
              </ol>
            </nav>
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              <Save className="size-3" />
              {saving ? "Saving…" : lastSaved ? `Saved ${lastSaved.toLocaleTimeString()}` : "Answers save automatically"}
            </p>
            <Button className="w-full" variant="secondary" onClick={() => void save().then(() => setConfirm(true))}>
              Finish attempt…
            </Button>
          </CardContent>
        </Card>
      </aside>

      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Submit all and finish?</AlertDialogTitle>
            <AlertDialogDescription>
              {unanswered ? `${unanswered} question${unanswered > 1 ? "s are" : " is"} not answered. ` : "All questions are answered. "}
              You will not be able to change your answers after submitting.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Return to attempt</AlertDialogCancel>
            <AlertDialogAction disabled={finishing} onClick={() => void finish()}>
              {finishing ? "Submitting…" : "Submit all and finish"}
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
  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="grid gap-3 pt-6 text-sm sm:grid-cols-2 lg:grid-cols-4">
          {!data.isOwner && (
            <div>
              <div className="text-xs text-muted-foreground">Student</div>
              <div className="font-medium">
                {data.user.firstName} {data.user.lastName}
              </div>
            </div>
          )}
          <div>
            <div className="text-xs text-muted-foreground">Attempt</div>
            <div className="font-medium">{a.preview ? "Preview" : a.attempt}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Started / finished</div>
            <div className="font-medium">
              {formatDate(a.startedAt)} / {finished ? formatDate(a.finishedAt) : "in progress"}
            </div>
          </div>
          {a.sumMarks !== undefined && (
            <div>
              <div className="text-xs text-muted-foreground">Marks</div>
              <div className="font-medium">
                {round(a.sumMarks)} / {round(a.totalMarks)}
              </div>
            </div>
          )}
          {a.grade !== undefined && (
            <div>
              <div className="text-xs text-muted-foreground">Grade</div>
              <div className="font-medium">{a.needsGrading ? "Not yet graded" : `${round(a.grade)} / ${a.gradeMax}`}</div>
            </div>
          )}
        </CardContent>
      </Card>
      {!finished && <p className="text-sm text-muted-foreground">This attempt is still in progress; responses shown are the last saved.</p>}
      {data.questions.map((x) => (
        <QuestionCard key={x.slotId} question={x} value={x.response} onChange={() => {}} readOnly>
          {data.canGrade && finished && !a.preview && <ManualGrade activityId={activityId} attemptId={a.id} question={x} />}
        </QuestionCard>
      ))}
      <Button variant="outline" render={<Link href={`/activities/${activityId}`} />}>
        Back to the quiz
      </Button>
    </div>
  );
}

function ManualGrade({ activityId, attemptId, question }: { activityId: string; attemptId: string; question: AttemptQuestion }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(question.state === "needs_grading");
  const [mark, setMark] = useState(question.mark != null ? String(question.mark) : "");
  const [comment, setComment] = useState(() => htmlToPlain(question.comment));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const n = Number(mark);
  const invalid = mark.trim() === "" || Number.isNaN(n) || n < 0 || n > question.maxMark;

  if (!open) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        Override mark / comment
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
          await api(`/quizzes/${activityId}/attempts/${attemptId}/slots/${question.slotId}/grade`, { body: { mark: n, comment: comment.trim() || null } });
          toast.success("Mark saved");
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
          <Label htmlFor={`mark-${question.slotId}`}>Mark (max {question.maxMark})</Label>
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
          <Label htmlFor={`comment-${question.slotId}`}>Comment</Label>
          <Textarea id={`comment-${question.slotId}`} rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />
        </div>
      </div>
      {error ? <ErrorAlert error={error} /> : null}
      <Button type="submit" size="sm" disabled={pending || invalid}>
        {pending ? "Saving…" : "Save mark"}
      </Button>
    </form>
  );
}
