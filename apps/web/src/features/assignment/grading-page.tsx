"use client";

import { ChevronLeft, ChevronRight, RotateCcw } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { EmptyState, ErrorAlert, HtmlContent, PageHeader, QueryState, formatDate } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useActivity } from "@/features/activities/use-activity";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import { STATUS_LABEL, useGrade, useReopen, useSubmission, useSubmissions, type SubmissionDetail, type SubmissionList } from "./api";
import { FileList, StatusBadge } from "./index";
import { htmlToPlain, plainToHtml } from "./text";

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
            <ChevronLeft className="size-4" /> {activity.data.name}
          </Link>
          <PageHeader
            className="mt-2"
            title="Submissions"
            description={
              list.data
                ? `${list.data.counts.submitted} submitted · ${list.data.counts.needsGrading} to grade · ${list.data.counts.graded} graded${list.data.blindMarking ? " · Blind marking" : ""}`
                : undefined
            }
          />
          <QueryState query={list}>
            {list.data && (
              <div className="grid gap-6 lg:grid-cols-[minmax(260px,340px)_1fr]">
                <div className={cn("space-y-3", selected && "hidden lg:block")}>
                  <label className="sr-only" htmlFor="sub-filter">
                    Filter
                  </label>
                  <select
                    id="sub-filter"
                    className="h-8 w-full rounded-lg border bg-background px-2 text-sm"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value as Filter)}
                  >
                    <option value="all">All participants ({list.data.items.length})</option>
                    <option value="needs">Needs grading ({list.data.counts.needsGrading})</option>
                    <option value="missing">Not submitted</option>
                    <option value="graded">Graded</option>
                  </select>
                  {items.length === 0 ? (
                    <EmptyState title="Nobody here" />
                  ) : (
                    <ul className="divide-y rounded-xl border" aria-label="Participants">
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
                                {i.submission ? STATUS_LABEL[i.submission.status] : "No submission"}
                                {i.submission?.late && " · late"}
                              </span>
                            </span>
                            <span className="shrink-0 text-right text-xs">
                              {i.grade !== null ? (
                                <span className="font-semibold">
                                  {i.grade}/{list.data.gradeMax}
                                </span>
                              ) : i.needsGrading ? (
                                <Badge variant="secondary">To grade</Badge>
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
                          <ChevronLeft /> All participants
                        </Button>
                        <div className="ml-auto flex gap-1">
                          <Button variant="outline" size="sm" disabled={!prev} onClick={() => prev && select(prev.userId)} aria-label="Previous participant">
                            <ChevronLeft /> Previous
                          </Button>
                          <Button variant="outline" size="sm" disabled={!next} onClick={() => next && select(next.userId)} aria-label="Next participant">
                            Next <ChevronRight />
                          </Button>
                        </div>
                      </div>
                      <SubmissionPanel key={selected} activityId={activityId} userId={selected} list={list.data} onGraded={() => next && select(next.userId)} />
                    </>
                  ) : (
                    <EmptyState title="Select a participant" description="Pick someone from the list to review and grade their work." />
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
                    <span className="text-muted-foreground">Attempt {d.submission.attempt}</span>
                    {d.submission.submittedAt && <span className="text-muted-foreground">· Submitted {formatDate(d.submission.submittedAt)}</span>}
                  </div>
                  {d.submission.text ? (
                    <HtmlContent html={d.submission.text} className="max-h-[50vh] overflow-y-auto rounded-lg border bg-muted/20 p-3" />
                  ) : null}
                  <FileList files={d.submission.files} />
                  {!d.submission.text && !d.submission.files.length && <p className="text-muted-foreground">The submission is empty.</p>}
                </>
              ) : (
                <p className="text-muted-foreground">No submission yet.</p>
              )}
              {d.attempts.length > 1 && (
                <details className="text-xs text-muted-foreground">
                  <summary className="cursor-pointer">Previous attempts ({d.attempts.length - 1})</summary>
                  <ul className="mt-2 space-y-1">
                    {d.attempts.slice(1).map((a) => (
                      <li key={a.id}>
                        Attempt {a.attempt}: {STATUS_LABEL[a.status]}
                        {a.submittedAt && `, ${formatDate(a.submittedAt)}`}
                        {a.late && " (late)"}
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
                <CardTitle className="text-base">Grade</CardTitle>
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
                            toast.success("Submission reopened: the student can submit a new attempt");
                          } catch (err) {
                            toast.error(errorMessage(err));
                          }
                        }}
                      >
                        <RotateCcw /> Reopen for a new attempt
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
                  <CardTitle className="text-base">Feedback</CardTitle>
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
  const grade = useGrade(activityId, userId);
  const [value, setValue] = useState(d.feedback?.grade != null ? String(d.feedback.grade) : "");
  const [feedback, setFeedback] = useState(() => htmlToPlain(d.feedback?.feedback));
  const parsed = value.trim() === "" ? null : Number(value);
  const invalid = parsed !== null && (Number.isNaN(parsed) || parsed < 0 || parsed > gradeMax);
  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        if (invalid) return;
        try {
          await grade.mutateAsync({ grade: parsed, feedback: plainToHtml(feedback) || null });
          toast.success("Grade saved");
          onGraded();
        } catch (err) {
          toast.error(errorMessage(err));
        }
      }}
    >
      <div className="max-w-48 space-y-1.5">
        <Label htmlFor="grade">Grade (out of {gradeMax})</Label>
        <Input
          id="grade"
          type="number"
          inputMode="decimal"
          min={0}
          max={gradeMax}
          step="any"
          value={value}
          aria-invalid={invalid || undefined}
          onChange={(e) => setValue(e.target.value)}
        />
        {invalid && <p className="text-xs text-destructive">Enter a number between 0 and {gradeMax}.</p>}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="feedback">Feedback</Label>
        <Textarea id="feedback" rows={6} value={feedback} onChange={(e) => setFeedback(e.target.value)} />
      </div>
      {d.feedback && (
        <p className="text-xs text-muted-foreground">
          Last graded {formatDate(d.feedback.gradedAt)}
          {d.feedback.grader && ` by ${d.feedback.grader.firstName} ${d.feedback.grader.lastName}`}
        </p>
      )}
      {grade.isError && <ErrorAlert error={grade.error} />}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={grade.isPending || invalid}>
          {grade.isPending ? "Saving…" : "Save grade"}
        </Button>
        {reopen}
      </div>
    </form>
  );
}
