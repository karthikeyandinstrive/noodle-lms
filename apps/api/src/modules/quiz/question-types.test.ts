import { describe, expect, it } from "vitest";
import { gradeResponse, makeVariant, parseNumber, rightAnswerText, studentView, zQuestionInput } from "./question-types";

const mcSingle = {
  single: true,
  options: [
    { id: "a", text: "Paris", fraction: 1, feedback: "Yes" },
    { id: "b", text: "Lyon", fraction: 0, feedback: "" },
    { id: "c", text: "Nice", fraction: -0.5, feedback: "" },
  ],
};
const mcMulti = {
  single: false,
  options: [
    { id: "a", text: "2", fraction: 0.5, feedback: "" },
    { id: "b", text: "3", fraction: 0.5, feedback: "" },
    { id: "c", text: "4", fraction: -1, feedback: "" },
  ],
};

describe("multichoice", () => {
  it("single answer", () => {
    expect(gradeResponse("multichoice", mcSingle, { selected: ["a"] }).fraction).toBe(1);
    expect(gradeResponse("multichoice", mcSingle, { selected: ["b"] }).fraction).toBe(0);
    expect(gradeResponse("multichoice", mcSingle, { selected: ["c"] }).fraction).toBe(0); // negative clamps
    expect(gradeResponse("multichoice", mcSingle, { selected: ["a", "b"] }).fraction).toBe(0); // multiple on single
    expect(gradeResponse("multichoice", mcSingle, { selected: ["zzz"] }).fraction).toBe(0);
  });
  it("multiple answers sum and clamp", () => {
    expect(gradeResponse("multichoice", mcMulti, { selected: ["a", "b"] }).fraction).toBe(1);
    expect(gradeResponse("multichoice", mcMulti, { selected: ["a"] }).fraction).toBe(0.5);
    expect(gradeResponse("multichoice", mcMulti, { selected: ["a", "b", "c"] }).fraction).toBe(0);
    expect(gradeResponse("multichoice", mcMulti, { selected: ["a", "a"] }).fraction).toBe(0.5); // duplicates ignored
  });
  it("missing / malformed response scores 0", () => {
    expect(gradeResponse("multichoice", mcSingle, null).fraction).toBe(0);
    expect(gradeResponse("multichoice", mcSingle, { selected: "a" }).fraction).toBe(0);
  });
  it("validation requires a 100% option / positive sum", () => {
    const base = { type: "multichoice", name: "q", text: "t" };
    expect(zQuestionInput.safeParse({ ...base, data: mcSingle }).success).toBe(true);
    expect(zQuestionInput.safeParse({ ...base, data: { ...mcSingle, options: mcSingle.options.map((o) => ({ ...o, fraction: 0 })) } }).success).toBe(false);
    expect(zQuestionInput.safeParse({ ...base, data: { ...mcMulti, options: [mcMulti.options[0], mcMulti.options[2]] } }).success).toBe(false);
  });
});

describe("truefalse", () => {
  it("grades", () => {
    expect(gradeResponse("truefalse", { correct: true }, { value: true }).fraction).toBe(1);
    expect(gradeResponse("truefalse", { correct: true }, { value: false }).fraction).toBe(0);
    expect(gradeResponse("truefalse", { correct: false }, null).fraction).toBe(0);
  });
});

describe("shortanswer", () => {
  const data = {
    caseSensitive: false,
    answers: [
      { text: "Paris", fraction: 1 },
      { text: "par*", fraction: 0.5 },
    ],
  };
  it("exact, case-insensitive and wildcard", () => {
    expect(gradeResponse("shortanswer", data, { text: "paris" }).fraction).toBe(1);
    expect(gradeResponse("shortanswer", data, { text: "  Paris  " }).fraction).toBe(1);
    expect(gradeResponse("shortanswer", data, { text: "Parisian" }).fraction).toBe(0.5);
    expect(gradeResponse("shortanswer", data, { text: "London" }).fraction).toBe(0);
    expect(gradeResponse("shortanswer", data, { text: "" }).fraction).toBe(0);
  });
  it("case sensitive", () => {
    const cs = { caseSensitive: true, answers: [{ text: "NaCl", fraction: 1 }] };
    expect(gradeResponse("shortanswer", cs, { text: "NaCl" }).fraction).toBe(1);
    expect(gradeResponse("shortanswer", cs, { text: "nacl" }).fraction).toBe(0);
  });
  it("regex metacharacters are literal", () => {
    const d = { caseSensitive: false, answers: [{ text: "a.b", fraction: 1 }] };
    expect(gradeResponse("shortanswer", d, { text: "a.b" }).fraction).toBe(1);
    expect(gradeResponse("shortanswer", d, { text: "axb" }).fraction).toBe(0);
  });
});

describe("numerical", () => {
  const data = {
    answers: [
      { value: 3.14, tolerance: 0.01, fraction: 1 },
      { value: 3, tolerance: 0, fraction: 0.5 },
    ],
  };
  it("tolerance and partial", () => {
    expect(gradeResponse("numerical", data, { value: "3.14" }).fraction).toBe(1);
    expect(gradeResponse("numerical", data, { value: "3.15" }).fraction).toBe(1);
    expect(gradeResponse("numerical", data, { value: "3,141" }).fraction).toBe(1);
    expect(gradeResponse("numerical", data, { value: "3" }).fraction).toBe(0.5);
    expect(gradeResponse("numerical", data, { value: "3.2" }).fraction).toBe(0);
    expect(gradeResponse("numerical", data, { value: "abc" }).fraction).toBe(0);
  });
  it("float noise", () => {
    expect(gradeResponse("numerical", { answers: [{ value: 0.3, tolerance: 0, fraction: 1 }] }, { value: String(0.1 + 0.2) }).fraction).toBe(1);
  });
  it("parseNumber", () => {
    expect(parseNumber("1e3")).toBe(1000);
    expect(parseNumber("-.5")).toBe(-0.5);
    expect(parseNumber("1.2.3")).toBeNaN();
    expect(parseNumber("")).toBeNaN();
  });
});

describe("essay", () => {
  it("needs manual grading unless empty", () => {
    expect(gradeResponse("essay", {}, { text: "Some answer" }).fraction).toBeNull();
    expect(gradeResponse("essay", {}, { text: "   " }).fraction).toBe(0);
    expect(gradeResponse("essay", {}, null).fraction).toBe(0);
  });
});

describe("matching", () => {
  const data = {
    pairs: [
      { id: "1", question: "France", answer: "Paris" },
      { id: "2", question: "Italy", answer: "Rome" },
      { id: "3", question: "", answer: "Berlin" },
    ],
  };
  it("partial credit per stem, distractors ignored", () => {
    expect(gradeResponse("matching", data, { matches: { "1": "Paris", "2": "Rome" } }).fraction).toBe(1);
    expect(gradeResponse("matching", data, { matches: { "1": "Paris", "2": "Berlin" } }).fraction).toBe(0.5);
    expect(gradeResponse("matching", data, { matches: {} }).fraction).toBe(0);
  });
  it("student view hides the pairing", () => {
    const v = makeVariant("matching", data, true, () => 0.3);
    const view = studentView("matching", data, v);
    expect(view.type).toBe("matching");
    if (view.type !== "matching") return;
    expect(view.stems.map((s) => s.id).sort()).toEqual(["1", "2"]);
    expect([...view.choices].sort()).toEqual(["Berlin", "Paris", "Rome"]);
    expect(JSON.stringify(view)).not.toContain("answer");
  });
});

describe("views never leak answers", () => {
  it("multichoice view has no fraction/feedback and follows the variant order", () => {
    const view = studentView("multichoice", mcSingle, { order: ["c", "a", "b"] });
    expect(view).toEqual({
      type: "multichoice",
      single: true,
      options: [
        { id: "c", text: "Nice" },
        { id: "a", text: "Paris" },
        { id: "b", text: "Lyon" },
      ],
    });
    expect(JSON.stringify(view)).not.toMatch(/fraction|feedback/);
  });
  it("truefalse view is empty", () => {
    expect(studentView("truefalse", { correct: true }, {})).toEqual({ type: "truefalse" });
  });
  it("right answer text", () => {
    expect(rightAnswerText("truefalse", { correct: false })).toBe("False");
    expect(rightAnswerText("multichoice", mcMulti)).toBe("2; 3");
  });
});
