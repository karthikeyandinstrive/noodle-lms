import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { canEditSubmission, participantNumbersFor, PARTICIPANT_NUMBER_MAX, PARTICIPANT_NUMBER_MIN, isLate, isPastCutoff, lateBySeconds, submissionState } from "./rules";

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

describe("participantNumbersFor", () => {
  const mac = (m: string) => createHmac("sha256", "test-secret").update(m).digest().readUInt32BE(0);
  const users = Array.from({ length: 300 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);

  it("gives every participant a distinct 4-digit number", () => {
    const nums = participantNumbersFor("asg-1", users, mac);
    expect(nums.size).toBe(users.length);
    const values = [...nums.values()];
    expect(new Set(values).size).toBe(values.length);
    for (const n of values) {
      expect(n).toBeGreaterThanOrEqual(PARTICIPANT_NUMBER_MIN);
      expect(n).toBeLessThanOrEqual(PARTICIPANT_NUMBER_MAX);
    }
  });

  it("is deterministic and independent of input order and duplicates", () => {
    const a = participantNumbersFor("asg-1", users, mac);
    const b = participantNumbersFor("asg-1", [...users].reverse().concat(users.slice(0, 5)), mac);
    expect([...b.entries()].sort()).toEqual([...a.entries()].sort());
  });

  it("keeps numbers stable when other people enrol or leave", () => {
    const before = participantNumbersFor("asg-1", users.slice(0, 50), mac);
    const after = participantNumbersFor("asg-1", users.slice(10, 50), mac);
    for (const id of users.slice(10, 50)) expect(after.get(id)).toBe(before.get(id));
  });

  it("differs between assignments", () => {
    const a = participantNumbersFor("asg-1", users.slice(0, 20), mac);
    const b = participantNumbersFor("asg-2", users.slice(0, 20), mac);
    expect(users.slice(0, 20).filter((u) => a.get(u) === b.get(u)).length).toBeLessThan(3);
  });

  it("resolves collisions deterministically by user id", () => {
    // Every first candidate collides; the lower user id keeps it, the other probes on.
    const colliding = (m: string) => (m.split(":").length === 2 ? 42 : m.length * 7919);
    const nums = participantNumbersFor("a", ["u2", "u1"], colliding);
    expect(nums.get("u1")).toBe(PARTICIPANT_NUMBER_MIN + 42);
    expect(nums.get("u2")).not.toBe(PARTICIPANT_NUMBER_MIN + 42);
    expect(participantNumbersFor("a", ["u1", "u2"], colliding)).toEqual(nums);
  });

  it("still terminates with a constant mac", () => {
    const nums = participantNumbersFor("a", ["u1", "u2", "u3"], () => 0);
    expect(new Set(nums.values()).size).toBe(3);
  });
});
