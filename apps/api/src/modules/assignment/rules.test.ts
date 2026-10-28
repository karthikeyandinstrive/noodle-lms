import { describe, expect, it } from "vitest";
import { blindOrder, canEditSubmission, isLate, isPastCutoff, lateBySeconds, submissionState } from "./rules";

const due = new Date("2026-03-01T12:00:00Z");

describe("lateness", () => {
  it("isLate", () => {
    expect(isLate(new Date("2026-03-01T11:59:59Z"), due)).toBe(false);
    expect(isLate(new Date("2026-03-01T12:00:00Z"), due)).toBe(false);
    expect(isLate(new Date("2026-03-01T12:00:01Z"), due)).toBe(true);
    expect(isLate(new Date("2030-01-01T00:00:00Z"), null)).toBe(false);
  });
  it("lateBySeconds", () => {
    expect(lateBySeconds(new Date("2026-03-01T13:00:00Z"), due)).toBe(3600);
    expect(lateBySeconds(new Date("2026-03-01T11:00:00Z"), due)).toBe(0);
    expect(lateBySeconds(new Date(), null)).toBe(0);
  });
  it("cut-off", () => {
    expect(isPastCutoff(new Date("2026-03-02T00:00:00Z"), due)).toBe(true);
    expect(isPastCutoff(new Date("2026-02-28T00:00:00Z"), due)).toBe(false);
    expect(isPastCutoff(new Date(), null)).toBe(false);
  });
});

describe("submission state", () => {
  it("canEditSubmission", () => {
    expect(canEditSubmission(null, false)).toBe(true);
    expect(canEditSubmission("draft", false)).toBe(true);
    expect(canEditSubmission("reopened", false)).toBe(true);
    expect(canEditSubmission("submitted", true)).toBe(true);
    expect(canEditSubmission("submitted", false)).toBe(false);
    expect(canEditSubmission("graded", true)).toBe(false);
  });
  it("submissionState honours cut-off", () => {
    const now = new Date("2026-03-01T13:00:00Z");
    expect(submissionState({ status: "draft", allowResubmit: true, cutoffAt: due }, now)).toMatchObject({ canEdit: false, canSubmit: false });
    expect(submissionState({ status: "draft", allowResubmit: true, cutoffAt: null }, now)).toMatchObject({ canEdit: true, canSubmit: true });
    expect(submissionState({ status: "submitted", allowResubmit: true, cutoffAt: null }, now)).toMatchObject({ canEdit: true, canSubmit: false });
    expect(submissionState({ status: "graded", allowResubmit: true, cutoffAt: null }, now).reason).toMatch(/graded/);
  });
});

describe("blindOrder", () => {
  it("is deterministic and independent of input order", () => {
    const h = (s: string) => s.split("").reverse().join("");
    expect(blindOrder(["ab", "ba", "cc"], h)).toEqual(blindOrder(["cc", "ab", "ba"], h));
  });
});
