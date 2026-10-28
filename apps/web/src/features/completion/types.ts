export type CompletionState = "incomplete" | "complete" | "complete_pass" | "complete_fail";
export type CompletionRule = "none" | "manual" | "view" | "submit" | "grade" | "pass";

export type MyProgress = {
  enabled: boolean;
  total: number;
  completed: number;
  percentage: number;
  completedAt: string | null;
  activities: { id: string; name: string; type: string; completionRule: CompletionRule; state: CompletionState }[];
};

export type CompletionReport = {
  course: { id: string; fullname: string; enableCompletion: boolean };
  activities: { id: string; name: string; type: string; completionRule: CompletionRule; visible: boolean }[];
  users: {
    items: { id: string; firstName: string; lastName: string; email?: string; completedAt: string | null; progress: number }[];
    total: number;
    page: number;
    pageSize: number;
  };
  states: { activityId: string; userId: string; state: CompletionState; completedAt: string | null; overridden: boolean }[];
  canOverride: boolean;
};

export const STATE_LABELS: Record<CompletionState, string> = {
  incomplete: "Not completed",
  complete: "Completed",
  complete_pass: "Completed (passed)",
  complete_fail: "Completed (failed)",
};

export const RULE_LABELS: Record<CompletionRule, string> = {
  none: "Not tracked",
  manual: "Marked by learner",
  view: "View",
  submit: "Submit",
  grade: "Receive a grade",
  pass: "Pass",
};

export const progressKey = (courseId: string) => ["completion", courseId, "me"] as const;
