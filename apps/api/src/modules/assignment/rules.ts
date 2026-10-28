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

export const PARTICIPANT_NUMBER_MIN = 1000;
export const PARTICIPANT_NUMBER_MAX = 9999;
const SPAN = PARTICIPANT_NUMBER_MAX - PARTICIPANT_NUMBER_MIN + 1;

/**
 * Blind-marking aliases ("Participant 4821"): a 4-digit number derived from a keyed
 * hash of (assignmentId, userId), so a learner keeps the same number when other
 * people enrol or leave and numbers can't be linked across assignments.
 *
 * `mac(message)` must return a non-negative integer from a keyed hash (HMAC).
 * Collisions are resolved deterministically: users are processed by user id and
 * each takes the first free number in its own probe sequence
 * (mac("<assignment>:<user>"), mac("<assignment>:<user>:1"), …). A number can
 * only change if a user with a lower id who collides with it joins the list.
 */
export function participantNumbersFor(assignmentId: string, userIds: string[], mac: (message: string) => number) {
  const ids = [...new Set(userIds)].sort();
  const taken = new Set<number>();
  const out = new Map<string, number>();
  for (const id of ids) {
    let n = 0;
    for (let k = 0; ; k++) {
      if (k >= 64) {
        // Pathological (more participants than numbers, or a broken mac): linear probe.
        let c = PARTICIPANT_NUMBER_MIN;
        while (taken.has(c) && c < PARTICIPANT_NUMBER_MAX + ids.length) c++;
        n = c;
        break;
      }
      const candidate = PARTICIPANT_NUMBER_MIN + (Math.abs(Math.trunc(mac(k ? `${assignmentId}:${id}:${k}` : `${assignmentId}:${id}`))) % SPAN);
      if (!taken.has(candidate)) {
        n = candidate;
        break;
      }
    }
    taken.add(n);
    out.set(id, n);
  }
  return out;
}
