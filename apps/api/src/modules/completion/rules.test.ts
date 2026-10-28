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

// follow-ups: the flush subscriber must emit only after the worker subscriber, outside its call stack.
const handlers: Array<(tx: unknown, p: unknown) => Promise<void>> = [];
const emitted: string[] = [];
vi.mock("../../core/events", () => ({
  on: (_name: string, h: (tx: unknown, p: unknown) => Promise<void>) => handlers.push(h),
  emit: async (name: string) => {
    emitted.push(name);
  },
}));
vi.mock("../../core/logger", () => ({ logger: { error: vi.fn() } }));

describe("subscribeWithFollowUps", () => {
  afterEach(() => {
    handlers.length = 0;
    emitted.length = 0;
  });
  it("defers follow-up emits until after both subscribers ran", async () => {
    const { subscribeWithFollowUps } = await import("./follow-ups");
    subscribeWithFollowUps("activity.viewed", async () => [
      { name: "activity.completed", payload: { organizationId: "o", activityId: "a", courseId: "c", userId: "u", state: "complete" } },
      { name: "course.completed", payload: { organizationId: "o", courseId: "c", userId: "u" } },
    ]);
    expect(handlers).toHaveLength(2);
    const payload = { organizationId: "o", activityId: "a", courseId: "c", userId: "u" };
    await handlers[0]!(null, payload);
    await handlers[1]!(null, payload);
    expect(emitted).toEqual([]); // not emitted synchronously (still inside the flush transaction)
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(emitted).toEqual(["activity.completed", "course.completed"]);
    // A second flush for the same payload emits nothing.
    await handlers[1]!(null, payload);
    await new Promise((r) => setImmediate(r));
    expect(emitted).toHaveLength(2);
  });
});
