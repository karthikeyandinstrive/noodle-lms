"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ErrorAlert, HtmlContent, QueryState } from "@/components/common";
import { RichTextEditor } from "@/components/rich-text-editor";
import { api } from "@/lib/api";
import { useFormat, useT } from "@/lib/i18n";
import { fmt, previewGrade, useAssessment, workshopKeys, type AssessmentDetail } from "./api";
import { SubmissionCard } from "./submission";

/** Reviewer's rubric form for one allocated (anonymized) submission. */
export function AssessmentPanel({ activityId, assessmentId, instructions }: { activityId: string; assessmentId: string; instructions?: string | null }) {
  const query = useAssessment(activityId, assessmentId);
  const t = useT();
  return (
    <QueryState query={query}>
      {query.data && (
        <div className="space-y-4">
          <SubmissionCard submission={query.data.submission} title={query.data.isOwnSubmission ? t("workshop.ownSubmissionSelf", "Your own submission (self-assessment)") : t("workshop.submissionToAssess", "Submission to assess")} />
          <HtmlContent html={instructions} />
          <RubricForm activityId={activityId} a={query.data} />
        </div>
      )}
    </QueryState>
  );
}

function RubricForm({ activityId, a }: { activityId: string; a: AssessmentDetail }) {
  const qc = useQueryClient();
  const router = useRouter();
  const t = useT();
  const fmtx = useFormat();
  const [scores, setScores] = useState<Record<string, string>>(() =>
    Object.fromEntries(a.criteria.map((c) => [c.id, a.scores?.[c.id] !== undefined ? String(a.scores[c.id]) : ""])),
  );
  const [feedback, setFeedback] = useState(() => a.feedback ?? "");
  const numeric = Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, v === "" ? undefined : Number(v)]));
  const preview = previewGrade(a.criteria, numeric);

  const save = useMutation({
    mutationFn: () =>
      api<{ grade: number }>(`/workshops/${activityId}/assessments/${a.id}`, {
        method: "PUT",
        body: { scores: numeric, feedback: feedback || null },
      }),
    onSuccess: async () => {
      toast.success(t("workshop.assessmentSubmitted", "Assessment submitted"));
      await qc.invalidateQueries({ queryKey: workshopKeys.all(activityId) });
      router.push(`/activities/${activityId}`);
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {t("workshop.assessment", "Assessment")}{" "}
          {a.submittedAt && <Badge variant="secondary">{t("workshop.submittedOn", "Submitted {date}", { date: fmtx.date(a.submittedAt) })}</Badge>}
        </CardTitle>
        <CardDescription>
          {a.canEdit
            ? t("workshop.assessHint", "Score every criterion, then add feedback for the author.")
            : t("workshop.assessLocked", "This assessment can no longer be changed.")}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {a.criteria.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("workshop.noCriteria", "The teacher hasn’t defined assessment criteria yet.")}</p>
        ) : (
          <form
            className="space-y-5"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            {save.isError && <ErrorAlert error={save.error} />}
            <fieldset className="space-y-4" disabled={!a.canEdit}>
              <legend className="sr-only">{t("workshop.criteria", "Criteria")}</legend>
              {a.criteria.map((c, i) => (
                <div key={c.id} className="space-y-1.5 rounded-lg border p-3">
                  <Label htmlFor={`crit-${c.id}`} className="leading-snug">
                    {i + 1}. {c.description}
                  </Label>
                  <div className="flex items-center gap-3">
                    <input
                      type="range"
                      min={0}
                      max={c.maxScore}
                      step={c.maxScore <= 10 ? 1 : "any"}
                      value={scores[c.id] === "" ? 0 : scores[c.id]}
                      onChange={(e) => setScores((s) => ({ ...s, [c.id]: e.target.value }))}
                      className="w-full accent-primary"
                      aria-label={t("workshop.criterionScore", "{criterion} score", { criterion: c.description })}
                      tabIndex={-1}
                    />
                    <div className="flex shrink-0 items-center gap-1 text-sm">
                      <Input
                        id={`crit-${c.id}`}
                        type="number"
                        min={0}
                        max={c.maxScore}
                        step="any"
                        required
                        className="h-8 w-20"
                        value={scores[c.id]}
                        onChange={(e) => setScores((s) => ({ ...s, [c.id]: e.target.value }))}
                      />
                      <span className="text-muted-foreground">
                        <span aria-hidden>/</span> <span className="sr-only">{t("workshop.outOf", "out of")}</span> {c.maxScore}
                      </span>
                    </div>
                  </div>
                  {c.weight !== 1 && <p className="text-xs text-muted-foreground">{t("workshop.weightN", "Weight {n}", { n: c.weight })}</p>}
                </div>
              ))}
              <div className="space-y-1.5">
                <Label htmlFor={a.canEdit ? "feedback" : undefined}>{t("workshop.feedbackForAuthor", "Feedback for the author")}</Label>
                {a.canEdit ? (
                  <RichTextEditor id="feedback" minHeight={160} value={feedback} onChange={setFeedback} />
                ) : (
                  <div className="rounded-lg border p-3 text-sm">{a.feedback ? <HtmlContent html={a.feedback} /> : "—"}</div>
                )}
              </div>
            </fieldset>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm" aria-live="polite">
                {t("workshop.gradeLabel", "Grade:")} <strong>{preview === null ? "—" : `${fmt(preview, 1)}%`}</strong>
              </p>
              {a.canEdit && (
                <Button type="submit" disabled={save.isPending || preview === null}>
                  {save.isPending
                    ? t("workshop.submitting", "Submitting…")
                    : a.submittedAt
                      ? t("workshop.updateAssessment", "Update assessment")
                      : t("workshop.submitAssessment", "Submit assessment")}
                </Button>
              )}
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
