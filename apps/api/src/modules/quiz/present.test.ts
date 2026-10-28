import { describe, expect, it } from "vitest";
import { presentQuestion, visibilityFor } from "./present";

const version = {
  id: "v1",
  organizationId: "o",
  questionId: "q",
  version: 1,
  type: "multichoice" as const,
  name: "Capital is Paris",
  text: "<p>Capital of France?</p>",
  defaultMark: 1,
  data: {
    single: true,
    options: [
      { id: "a", text: "Paris", fraction: 1, feedback: "Right!" },
      { id: "b", text: "Lyon", fraction: 0, feedback: "No" },
    ],
  },
  generalFeedback: "Paris is the capital",
  createdBy: null,
  createdAt: new Date(),
};
const answer = {
  id: "ans",
  organizationId: "o",
  attemptId: "att",
  slotId: "s1",
  questionVersionId: "v1",
  variant: { order: ["b", "a"] },
  response: { selected: ["a"] },
  fraction: 1,
  mark: 2,
  maxMark: 2,
  needsGrading: false,
  comment: "Well done",
  gradedBy: null,
  updatedAt: new Date(),
};
const allOn = { marks: true, correctness: true, feedback: true, rightAnswer: true };

describe("presentQuestion", () => {
  it("never leaks answers, marks, feedback or names to a learner during the attempt", () => {
    const show = visibilityFor({ finished: false, reviewer: false, reviewOptions: allOn });
    const out = presentQuestion({ answer, version }, 0, show, { reviewer: false, finished: false });
    const json = JSON.stringify(out);
    expect(json).not.toMatch(/fraction|Right!|Paris is the capital|Well done|Capital is Paris/);
    expect(out).not.toHaveProperty("mark");
    expect(out).not.toHaveProperty("state");
    expect(out).not.toHaveProperty("rightAnswer");
    expect(out.view).toEqual({
      type: "multichoice",
      single: true,
      options: [
        { id: "b", text: "Lyon" },
        { id: "a", text: "Paris" },
      ],
    });
    expect(out.response).toEqual({ selected: ["a"] });
  });

  it("honours review options after finishing", () => {
    const show = visibilityFor({ finished: true, reviewer: false, reviewOptions: { marks: true, correctness: false, feedback: false, rightAnswer: false } });
    const out = presentQuestion({ answer, version }, 0, show, { reviewer: false, finished: true });
    expect(out.mark).toBe(2);
    expect(out).not.toHaveProperty("state");
    expect(out).not.toHaveProperty("feedback");
    expect(out).not.toHaveProperty("rightAnswer");
    expect(out).not.toHaveProperty("name");
  });

  it("reviewers see everything", () => {
    const show = visibilityFor({ finished: true, reviewer: true, reviewOptions: { marks: false, correctness: false, feedback: false, rightAnswer: false } });
    const out = presentQuestion({ answer, version }, 0, show, { reviewer: true, finished: true });
    expect(out).toMatchObject({ name: "Capital is Paris", state: "correct", mark: 2, feedback: "Right!", comment: "Well done", rightAnswer: "Paris" });
  });

  it("needs-grading answers show no mark", () => {
    const show = visibilityFor({ finished: true, reviewer: false, reviewOptions: allOn });
    const out = presentQuestion({ answer: { ...answer, needsGrading: true, mark: null, fraction: null }, version }, 0, show, {
      reviewer: false,
      finished: true,
    });
    expect(out.state).toBe("needs_grading");
    expect(out.mark).toBeNull();
  });
});
