import { describe, expect, it } from "vitest";
import { buildIcs, escapeText, foldLine, htmlToText, icsDate } from "./ics";

describe("ics helpers", () => {
  it("escapes text values", () => {
    expect(escapeText("a,b;c\\d\ne")).toBe("a\\,b\;c\\\\d\\ne");
  });
  it("formats UTC dates", () => {
    expect(icsDate(new Date("2026-01-31T23:59:00.123Z"))).toBe("20260131T235900Z");
  });
  it("folds long lines at 75 octets without splitting characters", () => {
    const folded = foldLine(`SUMMARY:${"é".repeat(60)}`);
    for (const line of folded.split("\r\n")) expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
    expect(folded.replace(/\r\n /g, "")).toBe(`SUMMARY:${"é".repeat(60)}`);
    expect(foldLine("short")).toBe("short");
  });
  it("converts html descriptions to text", () => {
    expect(htmlToText("<p>Hello &amp; <b>welcome</b></p><p>Line 2</p>")).toBe("Hello & welcome\nLine 2");
  });
});

describe("buildIcs", () => {
  it("renders a calendar with events", () => {
    const ics = buildIcs(
      [
        { uid: "due-1@lms", name: "Essay, part 1", startsAt: new Date("2026-03-01T10:00:00Z"), durationMinutes: 0, url: "https://x.test/activities/1", categories: ["due"] },
        { uid: "ev-2@lms", name: "Lecture", description: "<p>Room 4</p>", startsAt: new Date("2026-03-02T09:00:00Z"), durationMinutes: 90 },
      ],
      { calendarName: "My calendar", now: new Date("2026-02-01T00:00:00Z") },
    );
    expect(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics).toContain("SUMMARY:Essay\\, part 1");
    expect(ics).toContain("DTSTART:20260302T090000Z\r\nDTEND:20260302T103000Z");
    expect(ics).toContain("DESCRIPTION:Room 4");
    expect(ics).toContain("DTSTAMP:20260201T000000Z");
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
  });
});
