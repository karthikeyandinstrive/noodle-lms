import { afterEach, describe, expect, it, vi } from "vitest";
import { courseProgress, isDone, stateForEvent, stateForGrade } from "./rules";

describe("stateForGrade", () => {
  it("ignores rules that do not use grades", () => {
    expect(stateForGrade("view", 10, 5)).toBeNull();
    expect(stateForGrade("manual", 10, null)).toBeNull();
  });
  it("grade rule: any grade completes, removal reverts", () => {
    expect(stateForGrade("grade", 0, 50)).toBe("complete");
    expect(stateForGrade("grade", null, 50)).toBe("incomplete");
  });
  it("pass rule compares with the pass grade", () => {
    expect(stateForGrade("pass", 60, 50)).toBe("complete_pass");
    expect(stateForGrade("pass", 50, 50)).toBe("complete_pass");
    expect(stateForGrade("pass", 49.9, 50)).toBe("complete_fail");
    expect(stateForGrade("pass", 1, null)).toBe("complete_pass");
    expect(stateForGrade("pass", null, 50)).toBe("incomplete");
  });
});

describe("stateForEvent", () => {
  it("maps view and submit rules", () => {
    expect(stateForEvent("view", "viewed")).toBe("complete");
    expect(stateForEvent("submit", "viewed")).toBeNull();
    expect(stateForEvent("submit", "submitted")).toBe("complete");
    expect(stateForEvent("grade", "submitted")).toBeNull();
  });
});

describe("courseProgress", () => {
  const acts = [
    { id: "a", completionRule: "view" as const },
    { id: "b", completionRule: "pass" as const },
    { id: "c", completionRule: "none" as const },
  ];
  it("counts only tracked activities; complete_fail is not done", () => {
    expect(courseProgress(acts, new Map([["a", "complete"], ["b", "complete_fail"]]))).toEqual({ total: 2, completed: 1, percentage: 50, complete: false });
    expect(courseProgress(acts, new Map([["a", "complete"], ["b", "complete_pass"]]))).toMatchObject({ completed: 2, percentage: 100, complete: true });
  });
  it("a course without tracked activities is never complete", () => {
    expect(courseProgress([{ id: "c", completionRule: "none" }], new Map())).toEqual({ total: 0, completed: 0, percentage: 0, complete: false });
  });
  it("isDone", () => {
    expect(isDone("complete")).toBe(true);
    expect(isDone("complete_pass")).toBe(true);
    expect(isDone("complete_fail")).toBe(false);
    expect(isDone(undefined)).toBe(false);
  });
});

// follow-ups: stored in the outbox through the caller's transaction, in order.
const emitted: Array<{ tx: unknown; name: string }> = [];
vi.mock("../../core/events", () => ({
  emitInTx: async (tx: unknown, name: string) => {
    emitted.push({ tx, name });
  },
}));

describe("emitFollowUps", () => {
  afterEach(() => {
    emitted.length = 0;
  });
  it("writes every follow-up with emitInTx on the given transaction, in order", async () => {
    const { emitFollowUps } = await import("./follow-ups");
    const tx = { marker: true };
    await emitFollowUps(tx as never, [
      { name: "activity.completed", payload: { organizationId: "o", activityId: "a", courseId: "c", userId: "u", state: "complete" } },
      { name: "course.completed", payload: { organizationId: "o", courseId: "c", userId: "u" } },
    ]);
    expect(emitted).toEqual([
      { tx, name: "activity.completed" },
      { tx, name: "course.completed" },
    ]);
    await emitFollowUps(tx as never, []);
    expect(emitted).toHaveLength(2);
  });
});
