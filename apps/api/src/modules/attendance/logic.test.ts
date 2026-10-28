import { describe, expect, it } from "vitest";
import { computeAttendance, toCsv, weeklyOccurrences, withinSession } from "./logic";

const points = { present: 2, late: 1, excused: 1, absent: 0 };

describe("computeAttendance", () => {
  it("computes points over taken sessions and scales to gradeMax", () => {
    const r = computeAttendance({
      sessions: [
        { id: "s1", taken: true },
        { id: "s2", taken: true },
        { id: "s3", taken: true },
        { id: "s4", taken: true },
      ],
      records: { s1: "present", s2: "late", s3: "absent", s4: "excused" },
      statusPoints: points,
      gradeMax: 100,
    });
    expect(r.sessions).toBe(4);
    expect(r.earned).toBe(4);
    expect(r.max).toBe(8);
    expect(r.percentage).toBe(50);
    expect(r.grade).toBe(50);
    expect(r.counts).toEqual({ present: 1, late: 1, excused: 1, absent: 1 });
  });

  it("counts taken sessions without a record as absent and ignores untaken ones", () => {
    const r = computeAttendance({
      sessions: [
        { id: "s1", taken: true },
        { id: "s2", taken: true },
        { id: "s3", taken: false },
      ],
      records: new Map([["s1", "present" as const]]),
      statusPoints: points,
      gradeMax: 10,
    });
    expect(r.sessions).toBe(2);
    expect(r.counts.absent).toBe(1);
    expect(r.grade).toBe(5);
  });

  it("counts self-marked records in sessions that were not formally taken", () => {
    const r = computeAttendance({
      sessions: [{ id: "s1", taken: false }],
      records: { s1: "present" },
      statusPoints: points,
      gradeMax: 20,
    });
    expect(r.grade).toBe(20);
  });

  it("returns a null grade when nothing counts yet or no status earns points", () => {
    expect(computeAttendance({ sessions: [{ id: "s1", taken: false }], records: {}, statusPoints: points, gradeMax: 100 }).grade).toBeNull();
    expect(
      computeAttendance({ sessions: [{ id: "s1", taken: true }], records: {}, statusPoints: { present: 0, late: 0, excused: 0, absent: 0 }, gradeMax: 100 }).grade,
    ).toBeNull();
  });

  it("uses the highest status value as the per-session maximum", () => {
    const r = computeAttendance({
      sessions: [{ id: "s1", taken: true }],
      records: { s1: "excused" },
      statusPoints: { present: 1, late: 0.5, excused: 3, absent: 0 },
      gradeMax: 9,
    });
    expect(r.grade).toBe(9);
  });
});

describe("weeklyOccurrences", () => {
  it("repeats weekly up to and including the end date", () => {
    const start = new Date("2026-01-05T09:00:00Z");
    const out = weeklyOccurrences(start, new Date("2026-01-26T09:00:00Z"));
    expect(out.map((d) => d.toISOString())).toEqual([
      "2026-01-05T09:00:00.000Z",
      "2026-01-12T09:00:00.000Z",
      "2026-01-19T09:00:00.000Z",
      "2026-01-26T09:00:00.000Z",
    ]);
  });
  it("returns only the start without an end date and respects the cap", () => {
    const start = new Date("2026-01-05T09:00:00Z");
    expect(weeklyOccurrences(start, null)).toHaveLength(1);
    expect(weeklyOccurrences(start, new Date("2030-01-01T00:00:00Z"), 10)).toHaveLength(10);
  });
});

describe("withinSession", () => {
  const s = { startsAt: new Date("2026-01-05T09:00:00Z"), durationMinutes: 60 };
  it("is open between start and end", () => {
    expect(withinSession(s, new Date("2026-01-05T08:59:59Z"))).toBe(false);
    expect(withinSession(s, new Date("2026-01-05T09:00:00Z"))).toBe(true);
    expect(withinSession(s, new Date("2026-01-05T10:00:00Z"))).toBe(true);
    expect(withinSession(s, new Date("2026-01-05T10:00:01Z"))).toBe(false);
  });
});

describe("toCsv", () => {
  it("quotes and neutralizes formulas", () => {
    expect(toCsv([["a", 'b"c', "d,e"], ["=SUM(A1)", null, 3]])).toBe('a,"b""c","d,e"\r\n\'=SUM(A1),,3\r\n');
  });
});
