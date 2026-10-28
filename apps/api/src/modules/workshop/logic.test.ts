import { describe, expect, it } from "vitest";
import { allocateReviewers, assessmentGrade, computeWorkshopGrades, totalGrade, type Criterion } from "./logic";

/** Deterministic PRNG (mulberry32) so allocation tests are reproducible. */
function seeded(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("assessmentGrade", () => {
  const criteria: Criterion[] = [
    { id: "a", description: "Content", maxScore: 10, weight: 2 },
    { id: "b", description: "Style", maxScore: 5, weight: 1 },
  ];

  it("computes the weighted normalized mean", () => {
    expect(assessmentGrade(criteria, { a: 10, b: 5 })).toBe(100);
    expect(assessmentGrade(criteria, { a: 0, b: 0 })).toBe(0);
    // (2*0.5 + 1*1) / 3 = 0.6667
    expect(assessmentGrade(criteria, { a: 5, b: 5 })).toBeCloseTo(66.66667, 4);
  });

  it("rejects missing or out-of-range scores", () => {
    expect(() => assessmentGrade(criteria, { a: 5 })).toThrow(/Missing score/);
    expect(() => assessmentGrade(criteria, { a: 11, b: 1 })).toThrow(/between 0 and 10/);
    expect(() => assessmentGrade(criteria, { a: -1, b: 1 })).toThrow();
    expect(() => assessmentGrade([], {})).toThrow(/no assessment criteria/);
  });
});

describe("allocateReviewers", () => {
  const users = ["u1", "u2", "u3", "u4", "u5"];
  const submissions = users.map((u) => ({ id: `s-${u}`, authorId: u }));

  it("gives each submission k reviewers, never the author, with balanced load", () => {
    for (let seed = 0; seed < 100; seed++) {
    const out = allocateReviewers({ submissions, reviewers: users, perSubmission: 3, allowSelf: false, random: seeded(seed) });
    expect(out).toHaveLength(15);
    for (const s of submissions) {
      const revs = out.filter((a) => a.submissionId === s.id).map((a) => a.reviewerId);
      expect(revs).toHaveLength(3);
      expect(new Set(revs).size).toBe(3);
      expect(revs).not.toContain(s.authorId);
    }
    const load = users.map((u) => out.filter((a) => a.reviewerId === u).length);
    expect(Math.max(...load) - Math.min(...load)).toBeLessThanOrEqual(1);
    }
  });

  it("is balanced across many random seeds and uneven sizes", () => {
    for (let seed = 0; seed < 50; seed++) {
      const reviewers = ["r1", "r2", "r3", "r4", "u1", "u2", "u3"];
      const subs = [{ id: "s1", authorId: "u1" }, { id: "s2", authorId: "u2" }, { id: "s3", authorId: "u3" }];
      const out = allocateReviewers({ submissions: subs, reviewers, perSubmission: 2, allowSelf: false, random: seeded(seed) });
      expect(out).toHaveLength(6);
      for (const a of out) expect(subs.find((s) => s.id === a.submissionId)!.authorId).not.toBe(a.reviewerId);
      const load = reviewers.map((r) => out.filter((a) => a.reviewerId === r).length);
      expect(Math.max(...load) - Math.min(...load)).toBeLessThanOrEqual(1);
    }
  });

  it("allows self-assessment when enabled", () => {
    const out = allocateReviewers({ submissions: [{ id: "s1", authorId: "u1" }], reviewers: ["u1"], perSubmission: 1, allowSelf: true });
    expect(out).toEqual([{ submissionId: "s1", reviewerId: "u1" }]);
    expect(allocateReviewers({ submissions: [{ id: "s1", authorId: "u1" }], reviewers: ["u1"], perSubmission: 1, allowSelf: false })).toEqual([]);
  });

  it("assigns as many as possible when there are too few reviewers", () => {
    const out = allocateReviewers({ submissions: submissions.slice(0, 2), reviewers: ["u1", "u2"], perSubmission: 3, allowSelf: false });
    expect(out).toHaveLength(2);
    expect(out).toContainEqual({ submissionId: "s-u1", reviewerId: "u2" });
    expect(out).toContainEqual({ submissionId: "s-u2", reviewerId: "u1" });
  });

  it("tops up existing allocations without duplicating them and counts their load", () => {
    const existing = [
      { submissionId: "s-u1", reviewerId: "u2" },
      { submissionId: "s-u1", reviewerId: "u3" },
    ];
    const out = allocateReviewers({ submissions, reviewers: users, perSubmission: 2, allowSelf: false, existing, random: seeded(7) });
    expect(out.filter((a) => a.submissionId === "s-u1")).toHaveLength(0);
    expect(out).toHaveLength(8);
    const all = [...existing, ...out];
    const load = users.map((u) => all.filter((a) => a.reviewerId === u).length);
    expect(Math.max(...load) - Math.min(...load)).toBeLessThanOrEqual(1);
    const pairs = all.map((a) => `${a.submissionId}:${a.reviewerId}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it("handles empty inputs", () => {
    expect(allocateReviewers({ submissions: [], reviewers: users, perSubmission: 3, allowSelf: false })).toEqual([]);
    expect(allocateReviewers({ submissions, reviewers: [], perSubmission: 3, allowSelf: false })).toEqual([]);
    expect(allocateReviewers({ submissions, reviewers: users, perSubmission: 0, allowSelf: false })).toEqual([]);
  });
});

describe("computeWorkshopGrades", () => {
  it("scales the mean of assessments and rewards reviewers close to the mean", () => {
    const { submissionGrades, assessmentQuality, reviewerGrades } = computeWorkshopGrades({
      submissionGradeMax: 80,
      assessmentGradeMax: 20,
      assessments: [
        { id: "a1", submissionId: "s1", reviewerId: "r1", grade: 80 },
        { id: "a2", submissionId: "s1", reviewerId: "r2", grade: 60 },
        { id: "a3", submissionId: "s1", reviewerId: "r3", grade: 70 },
        { id: "a4", submissionId: "s2", reviewerId: "r1", grade: 50 },
        { id: "a5", submissionId: "s3", reviewerId: "r2", grade: null },
      ],
    });
    // s1 mean 70 → 56/80; s2 mean 50 → 40/80; s3 has no submitted assessment.
    expect(submissionGrades.get("s1")).toBe(56);
    expect(submissionGrades.get("s2")).toBe(40);
    expect(submissionGrades.has("s3")).toBe(false);
    expect(assessmentQuality.get("a1")).toBe(90);
    expect(assessmentQuality.get("a2")).toBe(90);
    expect(assessmentQuality.get("a3")).toBe(100);
    expect(assessmentQuality.get("a4")).toBe(100);
    // r1: mean(90, 100) = 95 → 19/20; r2: 90 → 18/20; r3: 100 → 20/20
    expect(reviewerGrades.get("r1")).toBe(19);
    expect(reviewerGrades.get("r2")).toBe(18);
    expect(reviewerGrades.get("r3")).toBe(20);
  });

  it("supports per-assessment weights", () => {
    const { submissionGrades } = computeWorkshopGrades({
      submissionGradeMax: 100,
      assessmentGradeMax: 0,
      assessments: [
        { id: "a1", submissionId: "s1", reviewerId: "r1", grade: 100 },
        { id: "a2", submissionId: "s1", reviewerId: "r2", grade: 40 },
      ],
      weights: { a1: 2, a2: 1 },
    });
    expect(submissionGrades.get("s1")).toBe(80);
  });

  it("never gives a negative grading grade", () => {
    const { assessmentQuality } = computeWorkshopGrades({
      submissionGradeMax: 100,
      assessmentGradeMax: 100,
      assessments: [{ id: "a1", submissionId: "s1", reviewerId: "r1", grade: 100 }],
    });
    expect(assessmentQuality.get("a1")).toBe(100);
  });
});

describe("totalGrade", () => {
  it("prefers the override and adds the grading grade", () => {
    expect(totalGrade({ submission: 56, override: null, grading: 19 })).toBe(75);
    expect(totalGrade({ submission: 56, override: 70, grading: 19 })).toBe(89);
    expect(totalGrade({ submission: null, override: null, grading: 18 })).toBe(18);
    expect(totalGrade({ submission: null, override: null, grading: null })).toBeNull();
  });
});
