import { describe, expect, it } from "vitest";
import { zQuestionInput } from "../quiz/question-types";
import { giftEscape, giftUnescape, parseGift, serializeGift, type GiftQuestion } from "./gift";

const q = (over: Partial<GiftQuestion> & Pick<GiftQuestion, "type" | "data">): GiftQuestion => ({
  name: "Q",
  text: "Question text",
  defaultMark: 1,
  generalFeedback: null,
  ...over,
});

const one = (gift: string) => {
  const r = parseGift(gift);
  expect(r.errors).toEqual([]);
  expect(r.questions).toHaveLength(1);
  return r.questions[0]!;
};

// ─── Round trips ────────────────────────────────────────────────────────────

const FIXTURES: [string, GiftQuestion][] = [
  [
    "multichoice single with feedback",
    q({
      type: "multichoice",
      name: "Capital",
      text: "<p>What is the capital of <strong>France</strong>?</p>",
      generalFeedback: "<p>Paris has been the capital since 987.</p>",
      data: {
        single: true,
        options: [
          { id: "a", text: "Paris", fraction: 1, feedback: "Right!" },
          { id: "b", text: "Lyon", fraction: 0, feedback: "No, that's the 3rd city." },
          { id: "c", text: "Marseille", fraction: 0, feedback: "" },
        ],
      },
    }),
  ],
  [
    "multichoice single with partial credit",
    q({
      type: "multichoice",
      data: {
        single: true,
        options: [
          { id: "a", text: "Best", fraction: 1, feedback: "" },
          { id: "b", text: "Almost", fraction: 0.5, feedback: "" },
          { id: "c", text: "Wrong", fraction: -0.25, feedback: "" },
        ],
      },
    }),
  ],
  [
    "multichoice multiple answers",
    q({
      type: "multichoice",
      name: "Primes",
      text: "Which are prime?",
      data: {
        single: false,
        options: [
          { id: "a", text: "2", fraction: 0.5, feedback: "" },
          { id: "b", text: "3", fraction: 0.5, feedback: "Yes" },
          { id: "c", text: "4", fraction: -1, feedback: "" },
          { id: "d", text: "9", fraction: 0, feedback: "" },
        ],
      },
    }),
  ],
  [
    "multichoice multiple with a single 100% option",
    q({
      type: "multichoice",
      data: {
        single: false,
        options: [
          { id: "a", text: "Only", fraction: 1, feedback: "" },
          { id: "b", text: "Not", fraction: 0, feedback: "" },
        ],
      },
    }),
  ],
  [
    "multichoice with every special character",
    q({
      type: "multichoice",
      name: "Escapes: ~ = # { } \\ and colons::",
      text: "Pick 1+1=2 {set} #tag ~tilde a:b c\\d\nsecond line",
      generalFeedback: "GF with = and # and {braces}",
      data: {
        single: true,
        options: [
          { id: "a", text: "x = y", fraction: 1, feedback: "a # in feedback = fine" },
          { id: "b", text: "~approx {1}", fraction: 0, feedback: "" },
          { id: "c", text: "50%", fraction: 0, feedback: "" },
        ],
      },
    }),
  ],
  ["true", q({ type: "truefalse", text: "The sky is blue.", data: { correct: true } })],
  ["false with general feedback", q({ type: "truefalse", text: "2 + 2 = 5", generalFeedback: "It is 4.", data: { correct: false } })],
  [
    "short answer",
    q({
      type: "shortanswer",
      name: "Author",
      text: "Who wrote <em>Hamlet</em>?",
      data: {
        caseSensitive: false,
        answers: [
          { text: "Shakespeare", fraction: 1 },
          { text: "William Shakespeare", fraction: 1 },
          { text: "Shakes*", fraction: 0.5 },
        ],
      },
    }),
  ],
  ["numerical exact", q({ type: "numerical", text: "How many legs does a spider have?", data: { answers: [{ value: 8, tolerance: 0, fraction: 1 }] } })],
  ["numerical tolerance", q({ type: "numerical", text: "Pi?", data: { answers: [{ value: 3.14, tolerance: 0.01, fraction: 1 }] } })],
  ["numerical negative", q({ type: "numerical", text: "Freezing point in °F minus 40?", data: { answers: [{ value: -8, tolerance: 0.5, fraction: 1 }] } })],
  [
    "numerical multiple answers",
    q({
      type: "numerical",
      text: "When was Ulysses S. Grant born?",
      generalFeedback: "1822",
      data: {
        answers: [
          { value: 1822, tolerance: 0, fraction: 1 },
          { value: 1822, tolerance: 2, fraction: 0.5 },
        ],
      },
    }),
  ],
  [
    "matching with distractor",
    q({
      type: "matching",
      name: "Animals",
      text: "Match the animal with its sound.",
      data: {
        pairs: [
          { id: "p1", question: "cat", answer: "meow" },
          { id: "p2", question: "dog", answer: "woof" },
          { id: "p3", question: "cow", answer: "moo" },
          { id: "p4", question: "", answer: "quack" },
        ],
      },
    }),
  ],
  ["essay", q({ type: "essay", text: "Write about your summer.", data: {} })],
  ["essay with general feedback", q({ type: "essay", text: "Discuss.", generalFeedback: "<p>Look for structure.</p>", data: {} })],
  ["unicode", q({ type: "shortanswer", name: "Ελληνικά", text: "Как сказать «привет»? 李", data: { caseSensitive: false, answers: [{ text: "Zoë Ñúñez", fraction: 1 }] } })],
];

describe("GIFT round trip", () => {
  it.each(FIXTURES)("%s", (_label, fixture) => {
    const text = serializeGift([fixture]);
    const parsed = one(text);
    expect(parsed.question).toEqual(fixture);
    expect(zQuestionInput.safeParse(parsed.question).success).toBe(true);
  });

  it("round trips a whole document", () => {
    const all = FIXTURES.map(([, f]) => f);
    const text = serializeGift(all, { comment: "Exported from LMS\nCategory: Default" });
    expect(text.startsWith("// Exported from LMS\n// Category: Default\n\n")).toBe(true);
    const r = parseGift(text);
    expect(r.errors).toEqual([]);
    expect(r.questions.map((p) => p.question)).toEqual(all);
  });

  it("is stable when serialized twice", () => {
    const all = FIXTURES.map(([, f]) => f);
    const once = serializeGift(all);
    expect(serializeGift(parseGift(once).questions.map((p) => p.question))).toBe(once);
  });
});

// ─── Parsing hand-written GIFT ──────────────────────────────────────────────

describe("parseGift", () => {
  it("parses Moodle documentation examples", () => {
    const r = parseGift(`// true/false
::Q1:: 1+1=2 {T}

// multiple choice with specified feedback for right and wrong answers
::Q2:: What's between orange and green in the spectrum?
{ =yellow # right; good! ~red # wrong, it's yellow ~blue # wrong, it's yellow }

// fill-in-the-blank
::Q3:: Two plus {=two =2} equals four.

// matching
::Q4:: Which animal eats which food? { =cat -> cat food =dog -> dog food }

// math range question
::Q5:: What is a number from 1 to 5? {#3:2}

// math range specified with interval end points
::Q6:: What is a number from 1 to 5? {#1..5}

// multiple numeric answers with partial credit and feedback
::Q7:: When was Ulysses S. Grant born? {#
         =1822:0      # Correct! Full credit.
         =%50%1822:2  # He was born in 1822. Half credit for being close.
}

// essay
::Q8:: How are you? {}`);
    expect(r.errors).toEqual([]);
    const [q1, q2, q3, q4, q5, q6, q7, q8] = r.questions.map((p) => p.question);
    expect(q1).toMatchObject({ type: "truefalse", name: "Q1", text: "1+1=2", data: { correct: true } });
    expect(q2).toMatchObject({
      type: "multichoice",
      data: {
        single: true,
        options: [
          { id: "a", text: "yellow", fraction: 1, feedback: "right; good!" },
          { id: "b", text: "red", fraction: 0, feedback: "wrong, it's yellow" },
          { id: "c", text: "blue", fraction: 0, feedback: "wrong, it's yellow" },
        ],
      },
    });
    expect(q3).toMatchObject({
      type: "shortanswer",
      text: "Two plus _____ equals four.",
      data: { answers: [{ text: "two", fraction: 1 }, { text: "2", fraction: 1 }] },
    });
    expect(q4).toMatchObject({
      type: "matching",
      data: {
        pairs: [
          { question: "cat", answer: "cat food" },
          { question: "dog", answer: "dog food" },
        ],
      },
    });
    expect(q5).toMatchObject({ type: "numerical", data: { answers: [{ value: 3, tolerance: 2, fraction: 1 }] } });
    expect(q6).toMatchObject({ type: "numerical", data: { answers: [{ value: 3, tolerance: 2, fraction: 1 }] } });
    expect(q7).toMatchObject({
      type: "numerical",
      data: {
        answers: [
          { value: 1822, tolerance: 0, fraction: 1 },
          { value: 1822, tolerance: 2, fraction: 0.5 },
        ],
      },
    });
    expect(r.questions[6]!.warnings).toEqual(["Per-answer feedback is not supported for numerical questions and was dropped"]);
    expect(q8).toMatchObject({ type: "essay", text: "How are you?", data: {} });
    for (const p of r.questions) expect(zQuestionInput.safeParse(p.question).success).toBe(true);
  });

  it("accepts every true/false spelling and drops their feedback with a warning", () => {
    expect(one("A {T}").question.data).toEqual({ correct: true });
    expect(one("A {true}").question.data).toEqual({ correct: true });
    expect(one("A {F}").question.data).toEqual({ correct: false });
    expect(one("A {FALSE}").question.data).toEqual({ correct: false });
    const p = one("A {FALSE#wrong#right}");
    expect(p.question.data).toEqual({ correct: false });
    expect(p.warnings).toHaveLength(1);
  });

  it("parses multiple-answer weights including negative ones", () => {
    const p = one("What two people are entombed in Grant's tomb? {~%-100%No one ~%50%Grant ~%50%Grant's wife ~%-100%Grant's father}");
    expect(p.question.data).toEqual({
      single: false,
      options: [
        { id: "a", text: "No one", fraction: -1, feedback: "" },
        { id: "b", text: "Grant", fraction: 0.5, feedback: "" },
        { id: "c", text: "Grant's wife", fraction: 0.5, feedback: "" },
        { id: "d", text: "Grant's father", fraction: -1, feedback: "" },
      ],
    });
  });

  it("uses the text as the name when there is no title", () => {
    expect(one("Who's buried in Grant's tomb?{~Grant =no one}").question.name).toBe("Who's buried in Grant's tomb?");
    const long = "x".repeat(200);
    expect(one(`${long} {T}`).question.name).toHaveLength(80);
  });

  it("handles text formats", () => {
    expect(one("[html]<p>Hi <b>there</b></p>{T}").question.text).toBe("<p>Hi <b>there</b></p>");
    expect(one("[plain]1 < 2 & 3 > 2{T}").question.text).toBe("1 &lt; 2 &amp; 3 &gt; 2");
    expect(one("[markdown]**bold**{T}").question.text).toBe("**bold**");
    expect(one("Line one\nline two {T}").question.text).toBe("Line one<br>line two");
    expect(one("::T::[html]A\\nB{T}").question.text).toBe("A\nB");
  });

  it("keeps general feedback and per-answer feedback", () => {
    const p = one("Q {=a#good ~b#bad ####Read chapter 2}");
    expect(p.question.generalFeedback).toBe("Read chapter 2");
    expect(p.question.data).toMatchObject({ options: [{ feedback: "good" }, { feedback: "bad" }] });
  });

  it("ignores comments and blank lines and handles CRLF", () => {
    const r = parseGift("﻿// header\r\n\r\n\r\n// another\r\n::A::Q {T}\r\n// trailing comment\r\n\r\n::B::Q {F}\r\n");
    expect(r.errors).toEqual([]);
    expect(r.questions.map((p) => [p.title, p.line])).toEqual([
      ["A", 5],
      ["B", 8],
    ]);
  });

  it("reads $CATEGORY lines as paths", () => {
    const r = parseGift("$CATEGORY: $course$/top/Default for Course/Unit 1\n\n::A::Q {T}\n\n$CATEGORY: Algebra//Geometry/Sub\n::B::Q {F}\n\n$CATEGORY: $course$/top\n\n::C::Q {T}");
    expect(r.errors).toEqual([]);
    expect(r.questions.map((p) => p.category)).toEqual([["Default for Course", "Unit 1"], ["Algebra/Geometry", "Sub"], null]);
  });

  it("parses multi-line answer blocks with whitespace", () => {
    const p = one("::Multi::\nWhat is\n2+2?\n{\n  =4\n  ~3\n  ~5\n}");
    expect(p.question.text).toBe("What is<br>2+2?");
    expect(p.question.data).toMatchObject({ single: true, options: [{ text: "4" }, { text: "3" }, { text: "5" }] });
  });

  it("parses short answers with weights", () => {
    expect(one("Capital of Spain? {=Madrid =%50%madrid city}").question.data).toEqual({
      caseSensitive: false,
      answers: [
        { text: "Madrid", fraction: 1 },
        { text: "madrid city", fraction: 0.5 },
      ],
    });
  });

  it("reports unsupported constructs per question and keeps the others", () => {
    const r = parseGift(`::Good:: Q {T}

::Description:: Just some text

::Cloze:: A {=a} and B {=b}

::Broken:: Q {=a

::BadNumber:: Q {#abc}

::BadRange:: Q {#5..1}

::Mixed:: Q {=a -> b ~c}

::HalfMatching:: Q {=a -> b =c}

::Weight:: Q {=%150%a ~b}

::Unknown:: Q {what is this}

::Nested:: Q {=a {b} }

::Title`);
    expect(r.questions.map((p) => p.title)).toEqual(["Good"]);
    expect(r.errors.map((e) => e.title)).toEqual([
      "Description",
      "Cloze",
      "Broken",
      "BadNumber",
      "BadRange",
      "Mixed",
      "HalfMatching",
      "Weight",
      "Unknown",
      "Nested",
      null,
    ]);
    expect(r.errors[0]).toMatchObject({ line: 3, message: expect.stringMatching(/description/i) });
    expect(r.errors[1]!.message).toMatch(/Cloze/);
    for (const e of r.errors) expect(e.message.length).toBeGreaterThan(5);
  });

  it("returns schema-invalid questions for the caller to validate", () => {
    // A single-choice question with no 100% answer parses but fails validation.
    const p = one("Q {=%50%a ~b}");
    expect(zQuestionInput.safeParse(p.question).success).toBe(false);
  });
});

describe("escaping", () => {
  it("round trips arbitrary strings", () => {
    for (const s of ["", "plain", "a:b", "~=#{}", "back\\slash", "line\nbreak", "\\n literal", "::", "x\\"]) {
      expect(giftUnescape(giftEscape(s))).toBe(s);
    }
  });
  it("keeps unknown escapes", () => {
    expect(giftUnescape("\\d+")).toBe("\\d+");
  });
});
