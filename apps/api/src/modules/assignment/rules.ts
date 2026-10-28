/**
 * Pure assignment rules (unit-tested): lateness, cut-off and whether a learner
 * may still edit / submit their current submission.
 */

export type SubmissionStatus = "draft" | "submitted" | "graded" | "reopened";

/** A submission is late when it arrives after the due date. */
export function isLate(submittedAt: Date, dueAt: Date | null) {
  return !!dueAt && submittedAt.getTime() > dueAt.getTime();
}

/** After the cut-off date no submissions (or edits) are accepted. */
export function isPastCutoff(now: Date, cutoffAt: Date | null) {
  return !!cutoffAt && now.getTime() > cutoffAt.getTime();
}

/** Seconds a submission was late by (0 when on time). */
export function lateBySeconds(submittedAt: Date, dueAt: Date | null) {
  if (!dueAt) return 0;
  return Math.max(0, Math.floor((submittedAt.getTime() - dueAt.getTime()) / 1000));
}

/**
 * Whether the learner can change the content of their latest submission.
 *  - draft / reopened: yes
 *  - submitted: only when resubmission is allowed (it goes back to draft)
 *  - graded: no (a grader must reopen it)
 */
export function canEditSubmission(status: SubmissionStatus | null, allowResubmit: boolean) {
  if (status === null || status === "draft" || status === "reopened") return true;
  if (status === "submitted") return allowResubmit;
  return false;
}

export function submissionState(
  input: { status: SubmissionStatus | null; allowResubmit: boolean; cutoffAt: Date | null },
  now: Date,
): { canEdit: boolean; canSubmit: boolean; reason: string | null } {
  if (isPastCutoff(now, input.cutoffAt)) return { canEdit: false, canSubmit: false, reason: "The cut-off date has passed" };
  if (!canEditSubmission(input.status, input.allowResubmit)) {
    return {
      canEdit: false,
      canSubmit: false,
      reason: input.status === "graded" ? "Your submission has been graded" : "Your submission can no longer be changed",
    };
  }
  return { canEdit: true, canSubmit: input.status !== "submitted", reason: null };
}

/** Stable, opaque ordering of participants for blind marking. */
export function blindOrder(ids: string[], hash: (s: string) => string) {
  return [...ids].sort((a, b) => (hash(a) < hash(b) ? -1 : hash(a) > hash(b) ? 1 : 0));
}
