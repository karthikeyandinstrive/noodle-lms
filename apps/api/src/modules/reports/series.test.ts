import { describe, expect, it } from "vitest";
import { dayKey, fillDays, windowStart } from "./series";

describe("report series", () => {
  const now = new Date("2026-10-28T15:30:00Z");
  it("computes the window start at UTC midnight", () => {
    expect(windowStart(1, now).toISOString()).toBe("2026-10-28T00:00:00.000Z");
    expect(windowStart(30, now).toISOString()).toBe("2026-09-29T00:00:00.000Z");
  });
  it("fills missing days with zeros, oldest first", () => {
    const out = fillDays([{ date: "2026-10-27", value: 3 }, { date: "2026-10-28", value: 5 }], 3, now);
    expect(out).toEqual([
      { date: "2026-10-26", value: 0 },
      { date: "2026-10-27", value: 3 },
      { date: "2026-10-28", value: 5 },
    ]);
    expect(fillDays([], 30, now)).toHaveLength(30);
  });
  it("ignores rows outside the window and coerces numeric strings", () => {
    expect(fillDays([{ date: "2020-01-01", value: 9 }, { date: "2026-10-28", value: "2" as unknown as number }], 1, now)).toEqual([{ date: "2026-10-28", value: 2 }]);
    expect(dayKey(now)).toBe("2026-10-28");
  });
});
