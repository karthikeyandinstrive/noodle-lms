"use client";

import { ChevronLeft, ChevronRight, RotateCcw } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { EmptyState, ErrorAlert, HtmlContent, PageHeader, QueryState } from "@/components/common";
import { RichTextEditor } from "@/components/rich-text-editor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useActivity } from "@/features/activities/use-activity";
import { errorMessage } from "@/lib/api";
import { useFormat, useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { statusLabel, useGrade, useReopen, useSubmission, useSubmissions, type SubmissionDetail, type SubmissionList } from "./api";
import { FileList, StatusBadge } from "./index";

type Filter = "all" | "needs" | "missing" | "graded";

export function AssignmentGradingPage() {
  const activity = useActivity();
  const activityId = activity.activityId;
  const list = useSubmissions(activityId, !!activity.data);
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const selected = search.get("user");
  const [filter, setFilter] = useState<Filter>("all");
  const t = useT();

  const items = useMemo(() => {
    const all = list.data?.items ?? [];
    switch (filter) {
      case "needs":
        return all.filter((i) => i.needsGrading);
      case "missing":
        return all.filter((i) => !i.submission || i.submission.status === "draft" || i.submission.status === "reopened");
      case "graded":
        return all.filter((i) => i.grade !== null);
      default:
        return all;
    }
  }, [list.data, filter]);

  const select = (userId: string | null) => router.replace(userId ? `${pathname}?user=${userId}` : pathname, { scroll: false });

  // Default to the first participant needing grading on wide screens.
  useEffect(() => {
    if (!selected && list.data?.items.length && window.matchMedia("(min-width: 1024px)").matches) {
      const first = list.data.items.find((i) => i.needsGrading) ?? list.data.items[0]!;
      select(first.userId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.data, selected]);

  const index = items.findIndex((i) => i.userId === selected);
  const prev = index > 0 ? items[index - 1] : undefined;
  const next = index >= 0 && index < items.length - 1 ? items[index + 1] : undefined;

  return (
    <QueryState query={activity}>
      {activity.data && (
        <div>
          <Link href={`/activities/${activityId}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ChevronLeft className="size-4" aria-hidden /> {activity.data.name}
          </Link>
          <PageHeader
            className="mt-2"
            title={t("assignment.submissions", "Submissions")}
            description={
              list.data
                ? t("assignment.gradingSummary", "{submitted} submitted · {toGrade} to grade · {graded} graded", {
                    submitted: list.data.counts.submitted,
                    toGrade: list.data.counts.needsGrading,
                    graded: list.data.counts.graded,
                  }) + (list.data.blindMarking ? ` · ${t("assignment.blindMarking", "Blind marking")}` : "")
                : undefined
            }
          />
          <QueryState query={list}>
            {list.data && (
              <div className="grid gap-6 lg:grid-cols-[minmax(260px,340px)_1fr]">
                <div className={cn("space-y-3", selected && "hidden lg:block")}>
                  <label className="sr-only" htmlFor="sub-filter">
                    {t("assignment.filter", "Filter")}
                  </label>
                  <select
                    id="sub-filter"
                    className="h-8 w-full rounded-lg border bg-background px-2 text-sm"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value as Filter)}
                  >
                    <option value="all">{t("assignment.filterAll", "All participants ({n})", { n: list.data.items.length })}</option>
                    <option value="needs">{t("assignment.filterNeeds", "Needs grading ({n})", { n: list.data.counts.needsGrading })}</option>
                    <option value="missing">{t("assignment.notSubmitted", "Not submitted")}</option>
                    <option value="graded">{t("assignment.status.graded", "Graded")}</option>
                  </select>
                  {items.length === 0 ? (
                    <EmptyState title={t("assignment.nobodyHere", "Nobody here")} />
                  ) : (
                    <ul className="divide-y rounded-xl border" aria-label={t("assignment.participants", "Participants")}>
                      {items.map((i) => (
                        <li key={i.userId}>
                          <button
                            type="button"
                            onClick={() => select(i.userId)}
                            aria-current={i.userId === selected ? "true" : undefined}
                            className={cn(
                              "flex w-full items-start justify-between gap-2 p-3 text-left text-sm hover:bg-muted/50",
                              i.userId === selected && "bg-muted",
                            )}
                          >
                            <span className="min-w-0">
                              <span className="block truncate font-medium">{i.displayName}</span>
                              <span className="block text-xs text-muted-foreground">
                                {i.submission ? statusLabel(t, i.submission.status) : t("assignment.noSubmission", "No submission")}
                                {i.submission?.late && ` · ${t("assignment.lateLower", "late")}`}
                              </span>
                            </span>
                            <span className="shrink-0 text-right text-xs">
                              {i.grade !== null ? (
                                <span className="font-semibold">
                                  {i.grade}/{list.data.gradeMax}
                                </span>
                              ) : i.needsGrading ? (
                                <Badge variant="secondary">{t("assignment.toGrade", "To grade")}</Badge>
                              ) : null}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className={cn(!selected && "hidden lg:block")}>
                  {selected ? (
                    <>
                      <div className="mb-3 flex items-center justify-between gap-2">
                        <Button variant="ghost" size="sm" className="lg:hidden" onClick={() => select(null)}>
                          <ChevronLeft aria-hidden /> {t("assignment.allParticipants", "All participants")}
                        </Button>
                        <div className="ml-auto flex gap-1">
                          <Button variant="outline" size="sm" disabled={!prev} onClick={() => prev && select(prev.userId)} aria-label={t("assignment.previousParticipant", "Previous participant")}>
                            <ChevronLeft aria-hidden /> {t("common.previous", "Previous")}
                          </Button>
                          <Button variant="outline" size="sm" disabled={!next} onClick={() => next && select(next.userId)} aria-label={t("assignment.nextParticipant", "Next participant")}>
                            {t("common.next", "Next")} <ChevronRight aria-hidden />
                          </Button>
                        </div>
                      </div>
                      <SubmissionPanel key={selected} activityId={activityId} userId={selected} list={list.data} onGraded={() => next && select(next.userId)} />
                    </>
                  ) : (
                    <EmptyState
                      title={t("assignment.selectParticipant", "Select a participant")}
                      description={t("assignment.selectParticipantHint", "Pick someone from the list to review and grade their work.")}
                    />
                  )}
                </div>
              </div>
            )}
          </QueryState>
        </div>
      )}
    </QueryState>
  );
}

function SubmissionPanel({ activityId, userId, list, onGraded }: { activityId: string; userId: string; list: SubmissionList; onGraded: () => void }) {
  const q = useSubmission(activityId, userId);
  const reopen = useReopen(activityId, userId);
  const d = q.data;
  const t = useT();
  const fmt = useFormat();

  return (
    <QueryState query={q}>
      {d && (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                {d.participant.displayName}
                {d.participant.email && <span className="text-sm font-normal text-muted-foreground">{d.participant.email}</span>}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {d.submission ? (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={d.submission.status} late={d.submission.late} />
                    <span className="text-muted-foreground">{t("assignment.attemptN", "Attempt {n}", { n: d.submission.attempt })}</span>
                    {d.submission.submittedAt && (
                      <span className="text-muted-foreground">· {t("assignment.submittedOn", "Submitted {date}", { date: fmt.date(d.submission.submittedAt) })}</span>
                    )}
                  </div>
                  {d.submission.text ? (
                    <HtmlContent html={d.submission.text} className="max-h-[50vh] overflow-y-auto rounded-lg border bg-muted/20 p-3" />
                  ) : null}
                  <FileList files={d.submission.files} />
                  {!d.submission.text && !d.submission.files.length && <p className="text-muted-foreground">{t("assignment.submissionEmpty", "The submission is empty.")}</p>}
                </>
              ) : (
                <p className="text-muted-foreground">{t("assignment.noSubmissionYet", "No submission yet.")}</p>
              )}
              {d.attempts.length > 1 && (
                <details className="text-xs text-muted-foreground">
                  <summary className="cursor-pointer">{t("assignment.previousAttempts", "Previous attempts ({n})", { n: d.attempts.length - 1 })}</summary>
                  <ul className="mt-2 space-y-1">
                    {d.attempts.slice(1).map((a) => (
                      <li key={a.id}>
                        {t("assignment.attemptN", "Attempt {n}", { n: a.attempt })}: {statusLabel(t, a.status)}
                        {a.submittedAt && `, ${fmt.date(a.submittedAt)}`}
                        {a.late && ` (${t("assignment.lateLower", "late")})`}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </CardContent>
          </Card>

          {d.canGrade ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t("assignment.grade", "Grade")}</CardTitle>
              </CardHeader>
              <CardContent>
                <GradeForm
                  key={d.feedback?.gradedAt ?? "none"}
                  activityId={activityId}
                  userId={userId}
                  detail={d}
                  gradeMax={list.gradeMax}
                  onGraded={onGraded}
                  reopen={
                    d.submission && (d.submission.status === "submitted" || d.submission.status === "graded") ? (
                      <Button
                        type="button"
                        variant="outline"
                        disabled={reopen.isPending}
                        onClick={async () => {
                          try {
                            await reopen.mutateAsync();
                            toast.success(t("assignment.reopened", "Submission reopened: the student can submit a new attempt"));
                          } catch (err) {
                            toast.error(errorMessage(err));
                          }
                        }}
                      >
                        <RotateCcw aria-hidden /> {t("assignment.reopenForNewAttempt", "Reopen for a new attempt")}
                      </Button>
                    ) : null
                  }
                />
              </CardContent>
            </Card>
          ) : (
            d.feedback && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">{t("assignment.feedback", "Feedback")}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <p className="font-semibold">
                    {d.feedback.grade ?? "—"} / {d.gradeMax}
                  </p>
                  <HtmlContent html={d.feedback.feedback} />
                </CardContent>
              </Card>
            )
          )}
        </div>
      )}
    </QueryState>
  );
}

function GradeForm({
  activityId,
  userId,
  detail: d,
  gradeMax,
  onGraded,
  reopen,
}: {
  activityId: string;
  userId: string;
  detail: SubmissionDetail;
  gradeMax: number;
  onGraded: () => void;
  reopen: React.ReactNode;
}) {
  const t = useT();
  const fmt = useFormat();
  const grade = useGrade(activityId, userId);
  const [value, setValue] = useState(d.feedback?.grade != null ? String(d.feedback.grade) : "");
  const [feedback, setFeedback] = useState(() => d.feedback?.feedback ?? "");
  const parsed = value.trim() === "" ? null : Number(value);
  const invalid = parsed !== null && (Number.isNaN(parsed) || parsed < 0 || parsed > gradeMax);
  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        if (invalid) return;
        try {
          await grade.mutateAsync({ grade: parsed, feedback: feedback || null });
          toast.success(t("assignment.gradeSaved", "Grade saved"));
          onGraded();
        } catch (err) {
          toast.error(errorMessage(err));
        }
      }}
    >
      <div className="max-w-48 space-y-1.5">
        <Label htmlFor="grade">{t("assignment.gradeOutOf", "Grade (out of {max})", { max: gradeMax })}</Label>
        <Input
          id="grade"
          type="number"
          inputMode="decimal"
          min={0}
          max={gradeMax}
          step="any"
          value={value}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? "grade-error" : undefined}
          onChange={(e) => setValue(e.target.value)}
        />
        {invalid && (
          <p id="grade-error" className="text-xs text-destructive" role="alert">
            {t("assignment.gradeRange", "Enter a number between 0 and {max}.", { max: gradeMax })}
          </p>
        )}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="feedback">{t("assignment.feedback", "Feedback")}</Label>
        <RichTextEditor id="feedback" minHeight={160} value={feedback} onChange={setFeedback} />
      </div>
      {d.feedback && (
        <p className="text-xs text-muted-foreground">
          {d.feedback.grader
            ? t("assignment.lastGradedBy", "Last graded {date} by {name}", {
                date: fmt.date(d.feedback.gradedAt),
                name: `${d.feedback.grader.firstName} ${d.feedback.grader.lastName}`,
              })
            : t("assignment.lastGraded", "Last graded {date}", { date: fmt.date(d.feedback.gradedAt) })}
        </p>
      )}
      {grade.isError && <ErrorAlert error={grade.error} />}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={grade.isPending || invalid}>
          {grade.isPending ? t("common.saving", "Saving…") : t("assignment.saveGrade", "Save grade")}
        </Button>
        {reopen}
      </div>
    </form>
  );
}
