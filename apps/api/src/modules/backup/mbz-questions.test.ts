import { describe, expect, it } from "vitest";
import { DATA_SCHEMAS, type QuestionType } from "../quiz/question-types";
import type { RestoreReport } from "./format";
import { moodleQuizSlots, parseMoodleQuestions, plainText, randomFilter } from "./mbz-questions";
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
  <question id="45"><parent>0</parent><name>Random</name><questiontext>1</questiontext><qtype>random</qtype></question>
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
    // Random pseudo-questions aren't bank questions: they become random quiz slots.
    expect(r.unsupported).toEqual([]);
  });

  it("resolves 3.x quiz slots by question id", () => {
    const bank = parseMoodleQuestions(parseXml(LEGACY), report());
    const quiz = parseXml(`<quiz><question_instances><question_instance id="1"><slot>1</slot><questionid>41</questionid><maxmark>3</maxmark></question_instance><question_instance id="2"><slot>2</slot><questionid>45</questionid><maxmark>1</maxmark></question_instance></question_instances></quiz>`);
    const r = report();
    const slots = moodleQuizSlots(quiz.children[0]!, bank, r, "Q");
    expect(slots).toEqual([
      { questionId: "q41", pinnedVersion: null, position: 1, maxMark: 3 },
      { questionId: null, randomCategoryId: "3", randomIncludeSubcategories: true, position: 2, maxMark: 1 },
    ]);
    expect(r.warnings).toEqual([]);
  });

  it("turns Moodle HTML into plain option text", () => {
    expect(plainText("<p>Fish &amp; chips&nbsp;&#8364;5</p>")).toBe("Fish & chips €5");
    expect(plainText("a<br/>b")).toBe("a\nb");
    expect(plainText(null)).toBe("");
  });
});

const NEW_TYPES = `<question_categories><question_category id="9"><name>Maths</name><parent>0</parent><questions>
  <question id="60"><parent>0</parent><name>Area</name><questiontext>Area of a {w} by {h} rectangle?</questiontext><qtype>calculated</qtype>
    <plugin_qtype_calculated_question>
      <answers><answer id="70"><answertext>{w}*{h}</answertext><fraction>1.0000000</fraction></answer></answers>
      <dataset_definitions>
        <dataset_definition id="1"><name>w</name><options>uniform:1.0:10.0:1</options><dataset_items><dataset_item id="1"><number>1</number><value>2.5</value></dataset_item><dataset_item id="2"><number>2</number><value>4</value></dataset_item></dataset_items></dataset_definition>
        <dataset_definition id="2"><name>h</name><options>uniform:2:5:0</options><dataset_items><dataset_item id="3"><number>1</number><value>3</value></dataset_item><dataset_item id="4"><number>2</number><value>5</value></dataset_item></dataset_items></dataset_definition>
      </dataset_definitions>
      <calculated_records><calculated_record id="1"><answer>70</answer><tolerance>0.5</tolerance><tolerancetype>2</tolerancetype><correctanswerlength>1</correctanswerlength><correctanswerformat>1</correctanswerformat></calculated_record></calculated_records>
    </plugin_qtype_calculated_question></question>
  <question id="61"><parent>0</parent><name>Words</name><questiontext>The [[1]] sat on the [[2]].</questiontext><qtype>ddwtos</qtype>
    <plugin_qtype_ddwtos_question><ddwtos id="1"><shuffleanswers>0</shuffleanswers></ddwtos><answers>
      <answer id="80"><answertext>cat</answertext><fraction>0</fraction><feedback>O:8:"stdClass":2:{s:9:"draggroup";s:1:"1";s:8:"infinite";i:0;}</feedback></answer>
      <answer id="81"><answertext>mat</answertext><fraction>0</fraction><feedback>O:8:"stdClass":2:{s:9:"draggroup";i:2;s:8:"infinite";i:0;}</feedback></answer>
      <answer id="82"><answertext>dog</answertext><fraction>0</fraction><feedback>O:8:"stdClass":2:{s:9:"draggroup";s:1:"1";s:8:"infinite";i:0;}</feedback></answer>
    </answers></plugin_qtype_ddwtos_question></question>
  <question id="62"><parent>0</parent><name>Select</name><questiontext>[[1]] is blue</questiontext><qtype>gapselect</qtype>
    <plugin_qtype_gapselect_question><gapselect id="1"><shuffleanswers>1</shuffleanswers></gapselect><answers>
      <answer id="90"><answertext>Sky</answertext><fraction>0</fraction><feedback>1</feedback></answer>
      <answer id="91"><answertext>Grass</answertext><fraction>0</fraction><feedback>1</feedback></answer>
    </answers></plugin_qtype_gapselect_question></question>
</questions></question_category></question_categories>`;

describe("Moodle import of calculated, drag-and-drop text and random questions", () => {
  it("converts calculated questions with their tolerance and dataset items", () => {
    const bank = parseMoodleQuestions(parseXml(NEW_TYPES), report());
    const [calc, words, select] = bank.questions.map((q) => q.versions[0]!);
    expect(calc!.type).toBe("calculated");
    expect(calc!.data).toEqual({
      answers: [{ formula: "{w}*{h}", fraction: 1, tolerance: 0.5, toleranceType: "nominal", answerDecimals: 1, answerFormat: "decimals" }],
      variables: [
        { name: "w", min: 1, max: 10, decimals: 1 },
        { name: "h", min: 2, max: 5, decimals: 0 },
      ],
      datasets: [
        { w: 2.5, h: 3 },
        { w: 4, h: 5 },
      ],
    });
    expect(words).toMatchObject({ type: "gapselect", data: { shuffle: false, choices: [{ text: "cat", group: 1 }, { text: "mat", group: 2 }, { text: "dog", group: 1 }] } });
    expect(select).toMatchObject({ type: "gapselect", data: { shuffle: true, choices: [{ text: "Sky", group: 1 }, { text: "Grass", group: 1 }] } });
    for (const v of [calc!, words!, select!]) expect(DATA_SCHEMAS[v.type as QuestionType].safeParse(v.data).success, v.name).toBe(true);
  });

  it("reads Moodle 4.x random slot filters in both formats", () => {
    expect(randomFilter(`{"questioncategoryid":"9","includingsubcategories":"1"}`)).toEqual({ categoryId: "9", includeSubcategories: true });
    expect(randomFilter(`{"filter":{"category":{"jointype":1,"values":["9"],"filteroptions":{"includesubcategories":false}}}}`)).toEqual({ categoryId: "9", includeSubcategories: false });
    expect(randomFilter("not json")).toBeNull();

    const bank = parseMoodleQuestions(parseXml(NEW_TYPES), report());
    const quiz = parseXml(
      `<quiz><question_instances><question_instance id="1"><slot>1</slot><maxmark>2</maxmark><question_set_reference id="1"><filtercondition>{"questioncategoryid":"9","includingsubcategories":"0"}</filtercondition></question_set_reference></question_instance><question_instance id="2"><slot>2</slot><maxmark>1</maxmark><question_set_reference id="2"><filtercondition>{"questioncategoryid":"404"}</filtercondition></question_set_reference></question_instance></question_instances></quiz>`,
    );
    const r = report();
    expect(moodleQuizSlots(quiz.children[0]!, bank, r, "Q")).toEqual([{ questionId: null, randomCategoryId: "9", randomIncludeSubcategories: false, position: 1, maxMark: 2 }]);
    expect(r.warnings[0]).toMatch(/1 question slot/);
  });
});

