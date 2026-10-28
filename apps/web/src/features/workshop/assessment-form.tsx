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
import { Textarea } from "@/components/ui/textarea";
import { ErrorAlert, HtmlContent, QueryState, formatDate } from "@/components/common";
import { api } from "@/lib/api";
import { htmlToText, textToHtml } from "../forum/text";
import { fmt, previewGrade, useAssessment, workshopKeys, type AssessmentDetail } from "./api";
import { SubmissionCard } from "./submission";

/** Reviewer's rubric form for one allocated (anonymized) submission. */
export function AssessmentPanel({ activityId, assessmentId, instructions }: { activityId: string; assessmentId: string; instructions?: string | null }) {
  const query = useAssessment(activityId, assessmentId);
  return (
    <QueryState query={query}>
      {query.data && (
        <div className="space-y-4">
          <SubmissionCard submission={query.data.submission} title={query.data.isOwnSubmission ? "Your own submission (self-assessment)" : "Submission to assess"} />
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
  const [scores, setScores] = useState<Record<string, string>>(() =>
    Object.fromEntries(a.criteria.map((c) => [c.id, a.scores?.[c.id] !== undefined ? String(a.scores[c.id]) : ""])),
  );
  const [feedback, setFeedback] = useState(() => htmlToText(a.feedback));
  const numeric = Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, v === "" ? undefined : Number(v)]));
  const preview = previewGrade(a.criteria, numeric);

  const save = useMutation({
    mutationFn: () =>
      api<{ grade: number }>(`/workshops/${activityId}/assessments/${a.id}`, {
        method: "PUT",
        body: { scores: numeric, feedback: feedback.trim() ? textToHtml(feedback) : null },
      }),
    onSuccess: async () => {
      toast.success("Assessment submitted");
      await qc.invalidateQueries({ queryKey: workshopKeys.all(activityId) });
      router.push(`/activities/${activityId}`);
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          Assessment {a.submittedAt && <Badge variant="secondary">Submitted {formatDate(a.submittedAt)}</Badge>}
        </CardTitle>
        <CardDescription>
          {a.canEdit ? "Score every criterion, then add feedback for the author." : "This assessment can no longer be changed."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {a.criteria.length === 0 ? (
          <p className="text-sm text-muted-foreground">The teacher hasn&apos;t defined assessment criteria yet.</p>
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
              <legend className="sr-only">Criteria</legend>
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
                      aria-label={`${c.description} score`}
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
                      <span className="text-muted-foreground">/ {c.maxScore}</span>
                    </div>
                  </div>
                  {c.weight !== 1 && <p className="text-xs text-muted-foreground">Weight {c.weight}</p>}
                </div>
              ))}
              <div className="space-y-1.5">
                <Label htmlFor="feedback">Feedback for the author</Label>
                <Textarea id="feedback" rows={6} value={feedback} onChange={(e) => setFeedback(e.target.value)} />
              </div>
            </fieldset>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm" aria-live="polite">
                Grade: <strong>{preview === null ? "—" : `${fmt(preview, 1)}%`}</strong>
              </p>
              {a.canEdit && (
                <Button type="submit" disabled={save.isPending || preview === null}>
                  {save.isPending ? "Submitting…" : a.submittedAt ? "Update assessment" : "Submit assessment"}
                </Button>
              )}
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
