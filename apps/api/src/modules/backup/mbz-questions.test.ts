import { describe, expect, it } from "vitest";
import { DATA_SCHEMAS, type QuestionType } from "../quiz/question-types";
import type { RestoreReport } from "./format";
import { moodleQuizSlots, parseMoodleQuestions, plainText } from "./mbz-questions";
import { parseXml } from "./xml";

const report = (): RestoreReport => ({ counts: {}, warnings: [], unsupported: [] });

/** Moodle 3.x layout: questions directly inside their category. */
const LEGACY = `<question_categories><question_category id="3"><name>Default</name><parent>0</parent><questions>
  <question id="40"><parent>0</parent><name>Capital</name><questiontext>Capital of France?</questiontext><defaultmark>1</defaultmark><qtype>shortanswer</qtype>
    <plugin_qtype_shortanswer_question><answers><answer id="1"><answertext>Paris</answertext><fraction>1</fraction></answer><answer id="2"><answertext>paris france</answertext><fraction>0.5</fraction></answer><answer id="3"><answertext>*</answertext><fraction>0</fraction></answer></answers><shortanswer id="1"><usecase>0</usecase></shortanswer></plugin_qtype_shortanswer_question></question>
  <question id="41"><parent>0</parent><name>Pi</name><questiontext>Pi?</questiontext><qtype>numerical</qtype>
    <plugin_qtype_numerical_question><answers><answer id="5"><answertext>3.14</answertext><fraction>1</fraction></answer><answer id="6"><answertext>*</answertext><fraction>0</fraction></answer></answers><numerical_records><numerical_record id="1"><answer>5</answer><tolerance>0.01</tolerance></numerical_record></numerical_records></plugin_qtype_numerical_question></question>
  <question id="42"><parent>0</parent><name>Essay</name><questiontext>Discuss</questiontext><qtype>essay</qtype><plugin_qtype_essay_question><essay id="1"><responsetemplate>&lt;p&gt;Start here&lt;/p&gt;</responsetemplate></essay></plugin_qtype_essay_question></question>
  <question id="43"><parent>0</parent><name>Pairs</name><questiontext>Match</questiontext><qtype>match</qtype><plugin_qtype_match_question><matches><match id="1"><questiontext>Dog</questiontext><answertext>Bark</answertext></match><match id="2"><questiontext>Cat</questiontext><answertext>Meow</answertext></match><match id="3"><questiontext></questiontext><answertext>Moo</answertext></match></matches></plugin_qtype_match_question></question>
  <question id="44"><parent>43</parent><name>Sub</name><qtype>shortanswer</qtype></question>
  <question id="45"><parent>0</parent><name>Random</name><qtype>random</qtype></question>
</questions></question_category></question_categories>`;

describe("Moodle question import", () => {
  it("converts 3.x questions into valid data for each supported type", () => {
    const r = report();
    const bank = parseMoodleQuestions(parseXml(LEGACY), r);
    expect(bank.questions.map((q) => q.versions[0]!.type)).toEqual(["shortanswer", "numerical", "essay", "matching"]);
    for (const q of bank.questions) {
      const v = q.versions[0]!;
      expect(DATA_SCHEMAS[v.type as QuestionType].safeParse(v.data).success, v.name).toBe(true);
    }
    expect(bank.questions[0]!.versions[0]!.data).toEqual({ caseSensitive: false, answers: [{ text: "Paris", fraction: 1 }, { text: "paris france", fraction: 0.5 }] });
    expect(bank.questions[1]!.versions[0]!.data).toEqual({ answers: [{ value: 3.14, tolerance: 0.01, fraction: 1 }] });
    expect(bank.questions[2]!.versions[0]!.data).toEqual({ responseTemplate: "Start here" });
    expect(r.unsupported.join(" ")).toMatch(/1 Moodle question skipped \(type "random"\)/);
  });

  it("resolves 3.x quiz slots by question id", () => {
    const bank = parseMoodleQuestions(parseXml(LEGACY), report());
    const quiz = parseXml(`<quiz><question_instances><question_instance id="1"><slot>1</slot><questionid>41</questionid><maxmark>3</maxmark></question_instance><question_instance id="2"><slot>2</slot><questionid>45</questionid><maxmark>1</maxmark></question_instance></question_instances></quiz>`);
    const r = report();
    const slots = moodleQuizSlots(quiz.children[0]!, bank, r, "Q");
    expect(slots).toEqual([{ questionId: "q41", pinnedVersion: null, position: 1, maxMark: 3 }]);
    expect(r.warnings[0]).toMatch(/1 question slot/);
  });

  it("turns Moodle HTML into plain option text", () => {
    expect(plainText("<p>Fish &amp; chips&nbsp;&#8364;5</p>")).toBe("Fish & chips €5");
    expect(plainText("a<br/>b")).toBe("a\nb");
    expect(plainText(null)).toBe("");
  });
});
