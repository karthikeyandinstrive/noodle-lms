import { describe, expect, it } from "vitest";
import { parseManifest } from "./manifest";
import { leafStatus, rootStatus, Sequencer, type ActivityStatus, type SeqNode } from "./sequencing";

const rule = (conditions: string, action: string, combination = "all") =>
  `<imsss:ruleConditions conditionCombination="${combination}">${conditions}</imsss:ruleConditions><imsss:ruleAction action="${action}"/>`;

const MANIFEST = `<?xml version="1.0"?>
<manifest identifier="seq" xmlns="http://www.imsglobal.org/xsd/imscp_v1p1" xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_v1p3" xmlns:imsss="http://www.imsglobal.org/xsd/imsss">
  <metadata><schema>ADL SCORM</schema><schemaversion>2004 4th Edition</schemaversion></metadata>
  <organizations default="o">
    <organization identifier="o">
      <title>Course</title>
      <item identifier="intro" identifierref="r1"><title>Intro</title>
        <imsss:sequencing>
          <imsss:limitConditions attemptLimit="1"/>
          <imsss:rollupRules rollupObjectiveSatisfied="false"/>
        </imsss:sequencing>
      </item>
      <item identifier="module"><title>Module</title>
        <item identifier="lesson" identifierref="r2"><title>Lesson</title><imsss:sequencing IDRef="common"/></item>
        <item identifier="extra" identifierref="r3" isvisible="false"><title>Extra</title>
          <imsss:sequencing>
            <imsss:sequencingRules><imsss:preConditionRule>${rule('<imsss:ruleCondition condition="always"/>', "skip")}</imsss:preConditionRule></imsss:sequencingRules>
            <imsss:deliveryControls tracked="false"/>
          </imsss:sequencing>
        </item>
        <imsss:sequencing>
          <imsss:controlMode choice="true" flow="true" forwardOnly="true"/>
          <imsss:sequencingRules>
            <imsss:preConditionRule>${rule('<imsss:ruleCondition condition="completed" operator="not"/>', "stopForwardTraversal")}</imsss:preConditionRule>
          </imsss:sequencingRules>
          <imsss:rollupRules rollupObjectiveSatisfied="false"/>
        </imsss:sequencing>
      </item>
      <item identifier="test" identifierref="r4"><title>Test</title>
        <imsss:sequencing>
          <imsss:sequencingRules>
            <imsss:postConditionRule>${rule('<imsss:ruleCondition condition="satisfied" operator="not"/>', "retry")}</imsss:postConditionRule>
            <imsss:postConditionRule>${rule('<imsss:ruleCondition condition="satisfied"/>', "exitAll")}</imsss:postConditionRule>
          </imsss:sequencingRules>
          <imsss:objectives>
            <imsss:primaryObjective objectiveID="p" satisfiedByMeasure="true"><imsss:minNormalizedMeasure>0.8</imsss:minNormalizedMeasure></imsss:primaryObjective>
          </imsss:objectives>
        </imsss:sequencing>
      </item>
      <imsss:sequencing><imsss:controlMode choice="true" flow="true"/></imsss:sequencing>
    </organization>
  </organizations>
  <resources>
    <resource identifier="r1" type="webcontent" adlcp:scormType="sco" href="intro.html"/>
    <resource identifier="r2" type="webcontent" adlcp:scormType="sco" href="lesson.html"/>
    <resource identifier="r3" type="webcontent" adlcp:scormType="sco" href="extra.html"/>
    <resource identifier="r4" type="webcontent" adlcp:scormType="sco" href="test.html"/>
  </resources>
  <imsss:sequencingCollection>
    <imsss:sequencing ID="common">
      <imsss:controlMode choiceExit="false"/>
    </imsss:sequencing>
  </imsss:sequencingCollection>
</manifest>`;

const manifest = parseManifest(MANIFEST);
const tree = manifest.sequencing!.tree;
const all = new Set(manifest.scos.map((s) => s.identifier));

function engine(state: Record<string, [Record<string, string>, string]> = {}) {
  const leaves = new Map<string, ActivityStatus>(Object.entries(state).map(([id, [cmi, status]]) => [id, leafStatus(cmi, status)]));
  return new Sequencer(tree, leaves, all);
}

const find = (n: SeqNode, id: string): SeqNode | undefined => (n.id === id ? n : n.children.map((c) => find(c, id)).find(Boolean));

describe("sequencing: manifest", () => {
  it("builds the activity tree with control modes, rules, limits and collection references", () => {
    expect(tree.id).toBe("o");
    expect(tree.children.map((c) => c.id)).toEqual(["intro", "module", "test"]);
    expect(tree.seq).toMatchObject({ choice: true, flow: true });
    const module = find(tree, "module")!;
    expect(module.sco).toBeNull();
    expect(module.seq).toMatchObject({ flow: true, forwardOnly: true, rollupObjectiveSatisfied: false });
    expect(module.seq.preRules).toEqual([
      { combination: "all", conditions: [{ condition: "completed", not: true, measureThreshold: null }], action: "stopForwardTraversal" },
    ]);
    expect(find(tree, "lesson")!.seq.choiceExit).toBe(false);
    expect(find(tree, "extra")).toMatchObject({ visible: false, seq: { tracked: false } });
    expect(find(tree, "intro")!.seq.attemptLimit).toBe(1);
    expect(find(tree, "test")!.seq).toMatchObject({ satisfiedByMeasure: true, minNormalizedMeasure: 0.8 });
    expect(manifest.scos.find((s) => s.identifier === "test")!.scaledPassingScore).toBe(0.8);
  });

  it("leaves packages without sequencing (and SCORM 1.2) on free navigation", () => {
    const plain = MANIFEST.replace(/<imsss:sequencingCollection>[\s\S]*<\/imsss:sequencingCollection>/, "").replace(
      /<imsss:sequencing IDRef="common"\/>|<imsss:sequencing>[\s\S]*?<\/imsss:sequencing>/g,
      "",
    );
    expect(parseManifest(plain).sequencing).toBeUndefined();
  });
});

describe("sequencing: navigation", () => {
  it("starts with flow and continues into clusters, skipping by pre-condition rules", () => {
    const seq = engine();
    expect(seq.start()).toBe("intro");
    expect(seq.nav("intro", new Map())).toMatchObject({ continue: "lesson", previous: null });
    // extra is skipped; flow leaves the module for the test.
    expect(seq.nav("lesson", new Map()).continue).toBe("test");
    // forwardOnly on the module: no "previous" from inside it.
    expect(seq.nav("lesson", new Map()).previous).toBeNull();
    // Backward flow into the module enters it from the end (extra skipped).
    expect(seq.nav("test", new Map()).previous).toBe("lesson");
  });

  it("stops forward choice past an unfinished module and hides hidden items", () => {
    let seq = engine({ intro: [{ "cmi.completion_status": "incomplete" }, "incomplete"] });
    expect(seq.canChoose("test", "intro")).toBe(false);
    expect(seq.canChoose("lesson", "intro")).toBe(true);
    const items = seq.nav("intro", new Map()).items;
    expect(items.find((i) => i.identifier === "extra")!.hidden).toBe(true);
    expect(items.find((i) => i.identifier === "test")!.available).toBe(false);

    seq = engine({ intro: [{ "cmi.completion_status": "incomplete" }, "incomplete"], lesson: [{ "cmi.completion_status": "completed" }, "completed"] });
    // choiceExit=false on the lesson: can't leave it by choice …
    expect(seq.canChoose("test", "lesson")).toBe(false);
    // … but from the intro the (now completed) module no longer blocks the test.
    expect(seq.canChoose("test", "intro")).toBe(true);
    expect(seq.nav("lesson", new Map()).continue).toBe("test"); // flow still works
  });

  it("disables an activity once its attempt limit is used up", () => {
    const seq = engine({ intro: [{ "cmi.completion_status": "completed" }, "completed"] });
    expect(seq.canChoose("intro", "lesson")).toBe(false);
    expect(seq.nav("lesson", new Map()).items.find((i) => i.identifier === "intro")!.available).toBe(false);
    // Flow into a disabled activity is blocked, so start falls back to the first available choice.
    expect(seq.start((id) => id !== "intro")).toBe("lesson");
  });

  it("applies post-condition rules when an activity ends", () => {
    expect(engine({ test: [{ "cmi.score.scaled": "0.5" }, "failed"] }).afterExit("test", "continue")).toBe("test");
    expect(engine({ test: [{ "cmi.score.scaled": "0.9" }, "passed"] }).afterExit("test", null)).toBe("exit");
    expect(engine({ intro: [{ "cmi.completion_status": "incomplete" }, "incomplete"] }).afterExit("intro", "continue")).toBe("lesson");
    expect(engine().afterExit("intro", null)).toBeNull();
    // Two-valued rules: an unattempted test is "not satisfied", so it retries.
    expect(engine().afterExit("test", null)).toBe("test");
  });
});

describe("sequencing: rollup", () => {
  it("rolls completion over tracked children and satisfaction over contributing ones", () => {
    const done = { "cmi.completion_status": "completed" };
    expect(rootStatus(engine().rootStatus)).toBe("not attempted");
    expect(rootStatus(engine({ intro: [done, "completed"] }).rootStatus)).toBe("incomplete");
    // extra is untracked: the module completes with the lesson alone.
    const finished = engine({ intro: [done, "completed"], lesson: [done, "completed"], test: [{ ...done, "cmi.score.scaled": "0.9" }, "passed"] });
    expect(finished.rootStatus).toMatchObject({ completed: true, satisfied: true });
    expect(rootStatus(finished.rootStatus)).toBe("passed");
    // Only the test contributes to satisfaction.
    const failed = engine({ intro: [done, "completed"], lesson: [done, "completed"], test: [{ ...done, "cmi.score.scaled": "0.2" }, "failed"] });
    expect(rootStatus(failed.rootStatus)).toBe("failed");
    expect(failed.rootStatus.measure).toBeCloseTo(0.2);
  });

  it("supports explicit rollup rules with child sets", () => {
    const node = (id: string, children: SeqNode[] = [], sco: string | null = null, extra: Partial<SeqNode["seq"]> = {}): SeqNode => ({
      id,
      title: id,
      sco,
      visible: true,
      seq: { ...tree.seq, choice: true, flow: true, rollupRules: [], ...extra },
      children,
    });
    const root = node("r", [node("a", [], "a"), node("b", [], "b"), node("c", [], "c")], null, {
      rollupRules: [
        { childActivitySet: "atLeastCount", minimumCount: 2, minimumPercent: 0, combination: "all", conditions: [{ condition: "satisfied", not: false, measureThreshold: null }], action: "satisfied" },
        { childActivitySet: "any", minimumCount: 0, minimumPercent: 0, combination: "all", conditions: [{ condition: "satisfied", not: true, measureThreshold: null }], action: "notSatisfied" },
        { childActivitySet: "atLeastPercent", minimumCount: 0, minimumPercent: 0.5, combination: "all", conditions: [{ condition: "completed", not: false, measureThreshold: null }], action: "completed" },
      ],
    });
    const passed = leafStatus({ "cmi.completion_status": "completed" }, "passed");
    const failedLeaf = leafStatus({ "cmi.completion_status": "completed" }, "failed");
    const seq = new Sequencer(root, new Map([["a", passed], ["b", passed], ["c", failedLeaf]]), new Set(["a", "b", "c"]));
    // notSatisfied fires (c), but satisfied (2 of 3) is applied after it and wins.
    expect(seq.rootStatus).toMatchObject({ satisfied: true, completed: true });
    const one = new Sequencer(root, new Map([["a", passed], ["c", failedLeaf]]), new Set(["a", "b", "c"]));
    expect(one.rootStatus.satisfied).toBe(false);
    // 2 of 3 completed ≥ 50 %.
    expect(one.rootStatus.completed).toBe(true);
  });
});
