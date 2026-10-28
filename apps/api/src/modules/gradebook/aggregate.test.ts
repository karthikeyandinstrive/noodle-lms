import { describe, expect, it } from "vitest";
import { aggregate, computeTotals, csvCell, fromPercent, toCsv, toPercent, type TreeCategory, type TreeItem } from "./aggregate";

const e = (grade: number | null, max = 100, weight = 1, min = 0) => ({ grade, min, max, weight });

describe("toPercent / fromPercent", () => {
  it("normalises to the item's range and clamps", () => {
    expect(toPercent(5, 0, 10)).toBe(50);
    expect(toPercent(15, 10, 20)).toBe(50);
    expect(toPercent(30, 0, 20)).toBe(100);
    expect(toPercent(-1, 0, 20)).toBe(0);
    expect(toPercent(null, 0, 20)).toBeNull();
    expect(toPercent(5, 10, 10)).toBeNull();
  });
  it("maps percentages back to a scale", () => {
    expect(fromPercent(50, 0, 20)).toBe(10);
    expect(fromPercent(null, 0, 20)).toBeNull();
  });
});

describe("aggregate", () => {
  const entries = [e(5, 10), e(80), e(null), e(30, 50)]; // 50%, 80%, —, 60%

  it("ignores empty grades and returns null when nothing is graded", () => {
    expect(aggregate("mean", [e(null), e(null)])).toBeNull();
    expect(aggregate("mean", [])).toBeNull();
  });
  it("mean", () => expect(aggregate("mean", entries)).toBeCloseTo(63.33333, 4));
  it("weighted mean", () => {
    expect(aggregate("weighted_mean", [e(50, 100, 3), e(100, 100, 1)])).toBe(62.5);
    expect(aggregate("weighted_mean", [e(50, 100, 0), e(100, 100, 0)])).toBeNull();
  });
  it("sum (natural) uses points, not percentages", () => {
    // (5 + 80 + 30) / (10 + 100 + 50)
    expect(aggregate("sum", entries)).toBeCloseTo(71.875, 4);
  });
  it("highest / lowest / median", () => {
    expect(aggregate("highest", entries)).toBe(80);
    expect(aggregate("lowest", entries)).toBe(50);
    expect(aggregate("median", entries)).toBe(60);
    expect(aggregate("median", [e(10), e(20), e(30), e(40)])).toBe(25);
  });
  it("drops the lowest grades but always keeps one", () => {
    expect(aggregate("mean", entries, 1)).toBe(70); // drops 50%
    expect(aggregate("mean", entries, 10)).toBe(80); // keeps the best
  });
});

describe("computeTotals", () => {
  const categories: TreeCategory[] = [
    { id: "root", parentId: null, aggregation: "weighted_mean", dropLowest: 0 },
    { id: "hw", parentId: "root", aggregation: "mean", dropLowest: 1 },
  ];
  const items: TreeItem[] = [
    { id: "course", type: "course", categoryId: "root", gradeMin: 0, gradeMax: 100, weight: 1 },
    { id: "hwTotal", type: "category", categoryId: "hw", gradeMin: 0, gradeMax: 100, weight: 3 },
    { id: "exam", type: "activity", categoryId: "root", gradeMin: 0, gradeMax: 20, weight: 1 },
    { id: "hw1", type: "manual", categoryId: "hw", gradeMin: 0, gradeMax: 10, weight: 1 },
    { id: "hw2", type: "manual", categoryId: "hw", gradeMin: 0, gradeMax: 10, weight: 1 },
    { id: "hw3", type: "activity", categoryId: "hw", gradeMin: 0, gradeMax: 10, weight: 1 },
  ];

  it("aggregates nested categories with weights and drop-lowest", () => {
    const grades = new Map<string, number | null>([
      ["exam", 10], // 50%
      ["hw1", 2], // 20% — dropped
      ["hw2", 8], // 80%
      ["hw3", 10], // 100%
    ]);
    const out = computeTotals(categories, items, grades);
    expect(out.get("hwTotal")).toBe(90);
    // (90 * 3 + 50 * 1) / 4
    expect(out.get("course")).toBe(80);
  });

  it("returns null totals for a learner without grades", () => {
    const out = computeTotals(categories, items, new Map());
    expect(out.get("course")).toBeNull();
    expect(out.get("hwTotal")).toBeNull();
  });

  it("keeps overridden totals and uses them in the parent", () => {
    const grades = new Map<string, number | null>([["exam", 20]]);
    const out = computeTotals(categories, items, grades, new Map([["hwTotal", 0]]));
    expect(out.has("hwTotal")).toBe(false);
    expect(out.get("course")).toBe(25); // (0 * 3 + 100) / 4
  });

  it("does not recalculate a fixed course total", () => {
    const out = computeTotals(categories, items, new Map([["exam", 20]]), new Map([["course", 42]]));
    expect(out.has("course")).toBe(false);
  });

  it("treats items of unknown categories as root items and survives cycles", () => {
    const cyclic: TreeCategory[] = [
      { id: "root", parentId: null, aggregation: "mean", dropLowest: 0 },
      { id: "a", parentId: "b", aggregation: "mean", dropLowest: 0 },
      { id: "b", parentId: "a", aggregation: "mean", dropLowest: 0 },
    ];
    const out = computeTotals(
      cyclic,
      [
        { id: "course", type: "course", categoryId: "root", gradeMin: 0, gradeMax: 100, weight: 1 },
        { id: "x", type: "manual", categoryId: "gone", gradeMin: 0, gradeMax: 10, weight: 1 },
      ],
      new Map([["x", 7]]),
    );
    expect(out.get("course")).toBe(70);
  });
});

describe("CSV", () => {
  it("quotes and neutralises formulas", () => {
    expect(csvCell('a "b", c')).toBe('"a ""b"", c"');
    expect(csvCell("=HYPERLINK()")).toBe("'=HYPERLINK()");
    expect(csvCell(-5)).toBe("-5");
    expect(csvCell(null)).toBe("");
    expect(toCsv([["a", 1], ["b", null]])).toBe("a,1\r\nb,\r\n");
  });
});
