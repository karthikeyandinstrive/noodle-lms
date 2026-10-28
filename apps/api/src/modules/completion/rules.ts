/**
 * Pure completion rules (unit-tested in rules.test.ts).
 */

export const COMPLETION_STATES = ["incomplete", "complete", "complete_pass", "complete_fail"] as const;
export type CompletionState = (typeof COMPLETION_STATES)[number];
export type CompletionRule = "none" | "manual" | "view" | "submit" | "grade" | "pass";

/** States that count towards course completion. complete_fail does not. */
export const isDone = (state: CompletionState | null | undefined) => state === "complete" || state === "complete_pass";

/**
 * State implied by a grade change for "grade" / "pass" rules, or null when the rule does not use grades.
 *  - grade: any grade completes; removing the grade reverts to incomplete.
 *  - pass: compared to the item's pass grade; without a pass grade any grade counts as a pass.
 */
export function stateForGrade(rule: CompletionRule, finalGrade: number | null, gradePass: number | null): CompletionState | null {
  if (rule !== "grade" && rule !== "pass") return null;
  if (finalGrade === null) return "incomplete";
  if (rule === "grade") return "complete";
  if (gradePass === null || gradePass <= 0) return "complete_pass";
  return finalGrade >= gradePass ? "complete_pass" : "complete_fail";
}

/** The event-driven rule an event satisfies. */
export function stateForEvent(rule: CompletionRule, event: "viewed" | "submitted"): CompletionState | null {
  if (event === "viewed" && rule === "view") return "complete";
  if (event === "submitted" && rule === "submit") return "complete";
  return null;
}

export type TrackedActivity = { id: string; completionRule: CompletionRule };

/** Progress over the tracked activities (completionRule != none). */
export function courseProgress(activities: TrackedActivity[], stateOf: Map<string, CompletionState>) {
  const tracked = activities.filter((a) => a.completionRule !== "none");
  const completed = tracked.filter((a) => isDone(stateOf.get(a.id))).length;
  const total = tracked.length;
  return {
    total,
    completed,
    percentage: total ? Math.round((completed / total) * 100) : 0,
    /** A course with no tracked activities is never "complete" automatically. */
    complete: total > 0 && completed === total,
  };
}
