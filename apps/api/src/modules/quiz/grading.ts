/**
 * Pure quiz grading helpers (unit-tested): attempt totals and the quiz grade
 * derived from several attempts according to the quiz's grade method.
 */

export type GradeMethod = "highest" | "average" | "first" | "last";

/** Mark for an answer: fraction × maxMark, rounded to 5 decimals (column scale). */
export function markFor(fraction: number | null, maxMark: number) {
  if (fraction === null) return null;
  return round5(Math.max(0, Math.min(1, fraction)) * maxMark);
}

export const round5 = (n: number) => Math.round(n * 1e5) / 1e5;

/**
 * Totals an attempt. While any answer needs manual grading the attempt grade is
 * null (Moodle: "Not yet graded"), but the provisional sum is still reported.
 */
export function attemptTotals(answers: { mark: number | null; maxMark: number; needsGrading: boolean }[], gradeMax: number) {
  const totalMax = answers.reduce((s, a) => s + a.maxMark, 0);
  const sumMarks = round5(answers.reduce((s, a) => s + (a.mark ?? 0), 0));
  const needsGrading = answers.some((a) => a.needsGrading);
  const grade = needsGrading ? null : totalMax > 0 ? round5((sumMarks / totalMax) * gradeMax) : 0;
  return { sumMarks, totalMax, needsGrading, grade };
}

/**
 * Combines finished attempts into the quiz grade. Attempts without a grade
 * (awaiting manual grading) are ignored; null when nothing is graded yet.
 * `attempt` is the attempt number (ordering for first/last).
 */
export function aggregateGrade(method: GradeMethod, attempts: { attempt: number; grade: number | null }[]): number | null {
  const graded = attempts.filter((a): a is { attempt: number; grade: number } => a.grade !== null).sort((a, b) => a.attempt - b.attempt);
  if (!graded.length) return null;
  switch (method) {
    case "highest":
      return Math.max(...graded.map((a) => a.grade));
    case "average":
      return round5(graded.reduce((s, a) => s + a.grade, 0) / graded.length);
    case "first":
      return graded[0]!.grade;
    case "last":
      return graded[graded.length - 1]!.grade;
  }
}

/** Attempt deadline: the earlier of start + time limit and the quiz close time. */
export function attemptDueAt(now: Date, timeLimitSeconds: number | null, closeAt: Date | null): Date | null {
  const candidates: number[] = [];
  if (timeLimitSeconds && timeLimitSeconds > 0) candidates.push(now.getTime() + timeLimitSeconds * 1000);
  if (closeAt) candidates.push(closeAt.getTime());
  return candidates.length ? new Date(Math.min(...candidates)) : null;
}

/** Grace period for network latency on the last autosave/finish. */
export const SUBMIT_GRACE_MS = 30_000;

export function isOverdue(dueAt: Date | null, now: Date, graceMs = SUBMIT_GRACE_MS) {
  return !!dueAt && now.getTime() > dueAt.getTime() + graceMs;
}

/** Can a user start a new (non-preview) attempt? Returns the reason when not. */
export function canStartAttempt(
  quiz: { openAt: Date | null; closeAt: Date | null; attemptsAllowed: number },
  finishedCount: number,
  now: Date,
): { ok: true } | { ok: false; reason: string } {
  if (quiz.openAt && now < quiz.openAt) return { ok: false, reason: "This quiz is not open yet" };
  if (quiz.closeAt && now >= quiz.closeAt) return { ok: false, reason: "This quiz is closed" };
  if (quiz.attemptsAllowed > 0 && finishedCount >= quiz.attemptsAllowed) return { ok: false, reason: "No attempts left" };
  return { ok: true };
}

/** Facility index: mean fraction scored on a question (0..1), null when no graded answers. */
export function facilityIndex(fractions: (number | null)[]) {
  const graded = fractions.filter((f): f is number => f !== null);
  if (!graded.length) return null;
  return round5(graded.reduce((s, f) => s + f, 0) / graded.length);
}
