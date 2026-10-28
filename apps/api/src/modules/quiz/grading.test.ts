import { describe, expect, it } from "vitest";
import { aggregateGrade, attemptDueAt, attemptTotals, canStartAttempt, facilityIndex, isOverdue, markFor } from "./grading";

describe("aggregateGrade", () => {
  const attempts = [
    { attempt: 2, grade: 6 },
    { attempt: 1, grade: 4 },
    { attempt: 3, grade: 5 },
    { attempt: 4, grade: null },
  ];
  it("highest / average / first / last ignore ungraded attempts", () => {
    expect(aggregateGrade("highest", attempts)).toBe(6);
    expect(aggregateGrade("average", attempts)).toBe(5);
    expect(aggregateGrade("first", attempts)).toBe(4);
    expect(aggregateGrade("last", attempts)).toBe(5);
  });
  it("null when nothing graded", () => {
    expect(aggregateGrade("highest", [])).toBeNull();
    expect(aggregateGrade("last", [{ attempt: 1, grade: null }])).toBeNull();
  });
  it("average rounds", () => {
    expect(
      aggregateGrade("average", [
        { attempt: 1, grade: 1 },
        { attempt: 2, grade: 1 },
        { attempt: 3, grade: 2 },
      ]),
    ).toBe(1.33333);
  });
});

describe("attemptTotals", () => {
  it("scales to gradeMax", () => {
    const t = attemptTotals(
      [
        { mark: 1, maxMark: 1, needsGrading: false },
        { mark: 0.5, maxMark: 3, needsGrading: false },
      ],
      10,
    );
    expect(t).toEqual({ sumMarks: 1.5, totalMax: 4, needsGrading: false, grade: 3.75 });
  });
  it("no grade while needing manual grading", () => {
    const t = attemptTotals(
      [
        { mark: 1, maxMark: 1, needsGrading: false },
        { mark: null, maxMark: 1, needsGrading: true },
      ],
      10,
    );
    expect(t.grade).toBeNull();
    expect(t.needsGrading).toBe(true);
    expect(t.sumMarks).toBe(1);
  });
  it("zero max marks gives 0", () => {
    expect(attemptTotals([], 10).grade).toBe(0);
  });
  it("markFor clamps", () => {
    expect(markFor(1.5, 2)).toBe(2);
    expect(markFor(null, 2)).toBeNull();
    expect(markFor(1 / 3, 1)).toBe(0.33333);
  });
});

describe("timing", () => {
  const now = new Date("2026-01-01T10:00:00Z");
  it("dueAt = min(now + limit, close)", () => {
    expect(attemptDueAt(now, 600, null)?.toISOString()).toBe("2026-01-01T10:10:00.000Z");
    expect(attemptDueAt(now, 600, new Date("2026-01-01T10:05:00Z"))?.toISOString()).toBe("2026-01-01T10:05:00.000Z");
    expect(attemptDueAt(now, null, null)).toBeNull();
    expect(attemptDueAt(now, 0, null)).toBeNull();
  });
  it("overdue respects grace", () => {
    const due = new Date("2026-01-01T10:00:00Z");
    expect(isOverdue(due, new Date("2026-01-01T10:00:20Z"))).toBe(false);
    expect(isOverdue(due, new Date("2026-01-01T10:00:31Z"))).toBe(true);
    expect(isOverdue(null, now)).toBe(false);
  });
  it("canStartAttempt", () => {
    const quiz = { openAt: new Date("2026-01-01T09:00:00Z"), closeAt: new Date("2026-01-01T11:00:00Z"), attemptsAllowed: 2 };
    expect(canStartAttempt(quiz, 0, now).ok).toBe(true);
    expect(canStartAttempt(quiz, 2, now).ok).toBe(false);
    expect(canStartAttempt({ ...quiz, attemptsAllowed: 0 }, 50, now).ok).toBe(true);
    expect(canStartAttempt(quiz, 0, new Date("2026-01-01T08:00:00Z")).ok).toBe(false);
    expect(canStartAttempt(quiz, 0, new Date("2026-01-01T11:00:00Z")).ok).toBe(false);
  });
});

describe("facilityIndex", () => {
  it("mean of graded fractions", () => {
    expect(facilityIndex([1, 0, 0.5, null])).toBe(0.5);
    expect(facilityIndex([null])).toBeNull();
  });
});
