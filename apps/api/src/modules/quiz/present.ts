import type { attemptAnswers, questionVersions } from "@lms/db";
import { correctnessOf, presentText, rightAnswerText, responseFeedback, studentView, type QuestionType, type StudentView, type Variant } from "./question-types";

type AnswerRow = typeof attemptAnswers.$inferSelect;
type VersionRow = typeof questionVersions.$inferSelect;

export type ReviewOptions = { marks: boolean; correctness: boolean; feedback: boolean; rightAnswer: boolean };

/**
 * What the viewer may see of an attempt:
 *  - learner, attempt in progress → nothing beyond the questions and their own responses
 *  - learner, attempt finished    → the quiz's review options
 *  - reviewer (quiz:view_reports) → everything
 */
export function visibilityFor(input: { finished: boolean; reviewer: boolean; reviewOptions: ReviewOptions }): ReviewOptions {
  if (input.reviewer) return { marks: true, correctness: true, feedback: true, rightAnswer: true };
  if (!input.finished) return { marks: false, correctness: false, feedback: false, rightAnswer: false };
  return input.reviewOptions;
}

export type PresentedQuestion = {
  slotId: string;
  number: number;
  type: QuestionType;
  name?: string;
  text: string;
  maxMark: number;
  view: StudentView;
  response: unknown;
  state?: ReturnType<typeof correctnessOf>;
  mark?: number | null;
  feedback?: string | null;
  generalFeedback?: string | null;
  comment?: string | null;
  rightAnswer?: string | null;
};

/** Pure: builds the per-question payload, adding only the fields `show` allows. */
export function presentQuestion(
  row: { answer: AnswerRow; version: VersionRow },
  index: number,
  show: ReviewOptions,
  opts: { reviewer: boolean; finished: boolean },
): PresentedQuestion {
  const { answer, version } = row;
  const type = version.type as QuestionType;
  const variant = answer.variant as Variant;
  const ctx = { variant, text: version.text };
  const out: PresentedQuestion = {
    slotId: answer.slotId,
    number: index + 1,
    type,
    text: presentText(type, version.data, version.text, variant),
    maxMark: answer.maxMark,
    view: studentView(type, version.data, variant, version.text),
    response: answer.response ?? null,
  };
  // Question names are authoring labels and may hint at the answer.
  if (opts.reviewer) out.name = version.name;
  if (!opts.finished) {
    // Nothing is graded yet; reviewers may still see the key.
    if (opts.reviewer) out.rightAnswer = rightAnswerText(type, version.data, ctx);
    return out;
  }
  if (show.correctness) out.state = answer.needsGrading ? "needs_grading" : correctnessOf(answer.fraction);
  if (show.marks) out.mark = answer.needsGrading ? null : answer.mark;
  if (show.feedback) {
    out.feedback = responseFeedback(type, version.data, answer.response);
    out.generalFeedback = version.generalFeedback;
    out.comment = answer.comment;
  }
  if (show.rightAnswer) out.rightAnswer = rightAnswerText(type, version.data, ctx);
  return out;
}
