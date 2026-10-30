/**
 * SCORM 2004 Simple Sequencing (pure, no I/O): the activity tree parsed from the manifest's
 * `imsss:sequencing` elements, status rollup, and navigation (choice, continue/previous,
 * post-condition rules).
 *
 * Implemented from the SCORM 2004 4th Edition Sequencing and Navigation book:
 * - control modes: choice, choiceExit, flow, forwardOnly
 * - pre-condition rules (skip, disabled, hiddenFromChoice, stopForwardTraversal), exit-condition
 *   rules (exit) and post-condition rules (exitParent, exitAll, retry, retryAll, continue, previous)
 * - limit conditions (attemptLimit), delivery controls (tracked)
 * - rollup rules (all / any / none / atLeastCount / atLeastPercent) with the default rules when an
 *   activity defines none, rollupObjectiveSatisfied / rollupProgressCompletion,
 *   objectiveMeasureWeight measure rollup and satisfiedByMeasure
 * - sequencing collections (`IDRef`), merged per element with the item's own sequencing
 *
 * Not implemented (accepted, ignored): time limits and available-time ranges, constrained choice
 * and preventActivation (adlseq), rollup considerations (adlseq:requiredFor…), shared global
 * objectives and objective maps, auxiliary resources, and suspendAll across sessions (the attempt is
 * always resumable, as for single-SCO packages).
 */
import type { XmlNode } from "./manifest";

export type Tri = boolean | null;

export type RuleCondition = { condition: string; not: boolean; measureThreshold: number | null };
export type SeqRule = { combination: "all" | "any"; conditions: RuleCondition[]; action: string };
export type ChildSet = "all" | "any" | "none" | "atLeastCount" | "atLeastPercent";
export type RollupAction = "satisfied" | "notSatisfied" | "completed" | "incomplete";
export type RollupRule = {
  childActivitySet: ChildSet;
  minimumCount: number;
  minimumPercent: number;
  combination: "all" | "any";
  conditions: RuleCondition[];
  action: RollupAction;
};

export type Sequencing = {
  choice: boolean;
  choiceExit: boolean;
  flow: boolean;
  forwardOnly: boolean;
  preRules: SeqRule[];
  exitRules: SeqRule[];
  postRules: SeqRule[];
  attemptLimit: number | null;
  rollupRules: RollupRule[];
  rollupObjectiveSatisfied: boolean;
  rollupProgressCompletion: boolean;
  objectiveMeasureWeight: number;
  satisfiedByMeasure: boolean;
  minNormalizedMeasure: number;
  tracked: boolean;
};

/** One activity: the organization (root), a cluster, or a leaf launching a SCO (`sco` = item identifier). */
export type SeqNode = { id: string; title: string; sco: string | null; visible: boolean; seq: Sequencing; children: SeqNode[] };

export const DEFAULT_SEQUENCING: Sequencing = {
  choice: true,
  choiceExit: true,
  flow: false,
  forwardOnly: false,
  preRules: [],
  exitRules: [],
  postRules: [],
  attemptLimit: null,
  rollupRules: [],
  rollupObjectiveSatisfied: true,
  rollupProgressCompletion: true,
  objectiveMeasureWeight: 1,
  satisfiedByMeasure: false,
  minNormalizedMeasure: 1,
  tracked: true,
};

// ─── Parsing ────────────────────────────────────────────────────────────────

const localName = (name: string) => name.slice(name.indexOf(":") + 1);
const kids = (node: XmlNode | undefined, local: string) => (node ? node.children.filter((c) => c.local === local) : []);
const kid = (node: XmlNode | undefined, local: string) => kids(node, local)[0];
const textOf = (node: XmlNode | undefined): string => (node ? (node.text + node.children.map(textOf).join("")).trim() : "");
function attrOf(node: XmlNode | undefined, local: string): string | undefined {
  if (!node) return undefined;
  const want = local.toLowerCase();
  for (const [k, v] of Object.entries(node.attrs)) if (localName(k).toLowerCase() === want) return v;
  return undefined;
}
const bool = (v: string | undefined, fallback: boolean) => (v === undefined ? fallback : v.trim().toLowerCase() === "true");
const numOr = (v: string | undefined, fallback: number) => {
  const n = v === undefined || v.trim() === "" ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const MAX_RULES = 50;

function parseConditions(el: XmlNode | undefined, child: string): { combination: "all" | "any"; conditions: RuleCondition[] } {
  return {
    combination: attrOf(el, "conditionCombination") === "any" ? "any" : "all",
    conditions: kids(el, child)
      .slice(0, MAX_RULES)
      .map((c) => ({
        condition: attrOf(c, "condition") ?? "always",
        not: attrOf(c, "operator") === "not",
        measureThreshold: attrOf(c, "measureThreshold") === undefined ? null : numOr(attrOf(c, "measureThreshold"), 0),
      })),
  };
}

function parseRules(rulesEl: XmlNode | undefined, kind: "preConditionRule" | "exitConditionRule" | "postConditionRule"): SeqRule[] {
  return kids(rulesEl, kind)
    .slice(0, MAX_RULES)
    .map((r) => ({ ...parseConditions(kid(r, "ruleConditions"), "ruleCondition"), action: attrOf(kid(r, "ruleAction"), "action") ?? "" }))
    .filter((r) => r.action);
}

const CHILD_SETS: ChildSet[] = ["all", "any", "none", "atLeastCount", "atLeastPercent"];
const ROLLUP_ACTIONS: RollupAction[] = ["satisfied", "notSatisfied", "completed", "incomplete"];

/**
 * Sequencing of one item (or the organization). `collection` holds `imsss:sequencingCollection`
 * entries by ID; an `IDRef` takes each element from the collection unless the item has its own.
 */
export function parseSequencing(el: XmlNode | undefined, collection: Map<string, XmlNode>): Sequencing {
  const shared = el ? collection.get(attrOf(el, "IDRef") ?? "") : undefined;
  const pick = (local: string) => kid(el, local) ?? kid(shared, local);

  const control = pick("controlMode");
  const rules = pick("sequencingRules");
  const rollup = pick("rollupRules");
  const primary = kid(pick("objectives"), "primaryObjective");
  const limit = attrOf(pick("limitConditions"), "attemptLimit");
  const attemptLimit = limit === undefined ? null : Math.trunc(numOr(limit, 0)) || null;

  return {
    choice: bool(attrOf(control, "choice"), true),
    choiceExit: bool(attrOf(control, "choiceExit"), true),
    flow: bool(attrOf(control, "flow"), false),
    forwardOnly: bool(attrOf(control, "forwardOnly"), false),
    preRules: parseRules(rules, "preConditionRule"),
    exitRules: parseRules(rules, "exitConditionRule"),
    postRules: parseRules(rules, "postConditionRule"),
    attemptLimit: attemptLimit && attemptLimit > 0 ? attemptLimit : null,
    rollupRules: kids(rollup, "rollupRule")
      .slice(0, MAX_RULES)
      .map((r): RollupRule | null => {
        const action = attrOf(kid(r, "rollupAction"), "action") as RollupAction;
        if (!ROLLUP_ACTIONS.includes(action)) return null;
        const set = (attrOf(r, "childActivitySet") ?? "all") as ChildSet;
        return {
          childActivitySet: CHILD_SETS.includes(set) ? set : "all",
          minimumCount: Math.max(0, Math.trunc(numOr(attrOf(r, "minimumCount"), 0))),
          minimumPercent: Math.min(1, Math.max(0, numOr(attrOf(r, "minimumPercent"), 0))),
          ...parseConditions(kid(r, "rollupConditions"), "rollupCondition"),
          action,
        };
      })
      .filter((r): r is RollupRule => !!r),
    rollupObjectiveSatisfied: bool(attrOf(rollup, "rollupObjectiveSatisfied"), true),
    rollupProgressCompletion: bool(attrOf(rollup, "rollupProgressCompletion"), true),
    objectiveMeasureWeight: Math.min(1, Math.max(0, numOr(attrOf(rollup, "objectiveMeasureWeight"), 1))),
    satisfiedByMeasure: bool(attrOf(primary, "satisfiedByMeasure"), false),
    minNormalizedMeasure: numOr(textOf(kid(primary, "minNormalizedMeasure")) || undefined, 1),
    tracked: bool(attrOf(pick("deliveryControls"), "tracked"), true),
  };
}

/** True when the manifest uses IMS Simple Sequencing anywhere (otherwise the package keeps linear, free navigation). */
export function usesSequencing(node: XmlNode): boolean {
  if (node.local === "sequencing" || node.local === "sequencingCollection") return true;
  return node.children.some(usesSequencing);
}

// ─── Status ─────────────────────────────────────────────────────────────────

export type ActivityStatus = {
  attempted: boolean;
  /** Completion: true completed, false incomplete, null unknown. */
  completed: Tri;
  /** Primary objective: true satisfied, false not satisfied, null unknown. */
  satisfied: Tri;
  /** Normalized measure (−1…1), null unknown. */
  measure: number | null;
  /** Attempts on the activity (0 or 1 within one package attempt). */
  attemptCount: number;
};

export const UNKNOWN_STATUS: ActivityStatus = { attempted: false, completed: null, satisfied: null, measure: null, attemptCount: 0 };

/** A leaf's status from the SCO's run-time data (after completion threshold / passing score were applied). */
export function leafStatus(cmi: Record<string, string>, normalized: string): ActivityStatus {
  const scaled = cmi["cmi.score.scaled"] === undefined ? NaN : Number(cmi["cmi.score.scaled"]);
  const attempted = normalized !== "not attempted" || Object.keys(cmi).length > 0;
  return {
    attempted,
    completed: normalized === "completed" ? true : normalized === "incomplete" ? false : completionOf(cmi),
    satisfied: normalized === "passed" ? true : normalized === "failed" ? false : null,
    measure: Number.isFinite(scaled) ? scaled : null,
    attemptCount: attempted ? 1 : 0,
  };
}

function completionOf(cmi: Record<string, string>): Tri {
  const c = cmi["cmi.completion_status"];
  return c === "completed" ? true : c === "incomplete" ? false : null;
}

const and3 = (values: Tri[]): Tri => (values.some((v) => v === false) ? false : values.some((v) => v === null) ? null : true);
const or3 = (values: Tri[]): Tri => (values.some((v) => v === true) ? true : values.some((v) => v === null) ? null : false);

function limitExceeded(seq: Sequencing, s: ActivityStatus) {
  // An attempt counts against the limit once it has ended with a known outcome.
  return seq.attemptLimit !== null && s.attemptCount >= seq.attemptLimit && (s.completed === true || s.satisfied !== null);
}

/**
 * Sequencing rules (pre/exit/post) use two-valued logic, as Moodle and the 3rd Edition do: an
 * unknown status is false before `not` applies, so "not satisfied" holds for an unattempted
 * activity. Rollup rules keep three-valued logic (unknown never counts as true or false).
 */
function evalCondition(c: RuleCondition, seq: Sequencing, s: ActivityStatus, twoValued: boolean): Tri {
  let v: Tri;
  switch (c.condition) {
    case "satisfied":
      v = s.satisfied;
      break;
    case "objectiveStatusKnown":
      v = s.satisfied !== null;
      break;
    case "objectiveMeasureKnown":
      v = s.measure !== null;
      break;
    case "objectiveMeasureGreaterThan":
      v = s.measure === null ? null : s.measure > (c.measureThreshold ?? 0);
      break;
    case "objectiveMeasureLessThan":
      v = s.measure === null ? null : s.measure < (c.measureThreshold ?? 0);
      break;
    case "completed":
      v = s.completed;
      break;
    case "activityProgressKnown":
      v = s.completed !== null;
      break;
    case "attempted":
      v = s.attempted;
      break;
    case "attemptLimitExceeded":
      v = limitExceeded(seq, s);
      break;
    case "always":
      v = true;
      break;
    default:
      // timeLimitExceeded, outsideAvailableTimeRange: time tracking isn't enforced.
      v = false;
  }
  if (twoValued) v ??= false;
  return c.not && v !== null ? !v : v;
}

function evalConditions(r: { combination: "all" | "any"; conditions: RuleCondition[] }, seq: Sequencing, s: ActivityStatus, twoValued: boolean): Tri {
  const values = r.conditions.map((c) => evalCondition(c, seq, s, twoValued));
  return r.combination === "any" ? or3(values) : and3(values);
}

/** First rule (in document order) whose conditions hold and whose action is one of `actions`. */
function firedRule(rules: SeqRule[], actions: string[], seq: Sequencing, s: ActivityStatus) {
  return rules.find((r) => actions.includes(r.action) && evalConditions(r, seq, s, true) === true)?.action ?? null;
}

// ─── Rollup ─────────────────────────────────────────────────────────────────

const DEFAULT_RULES: Record<RollupAction, RollupRule> = {
  satisfied: { childActivitySet: "all", minimumCount: 0, minimumPercent: 0, combination: "all", conditions: [{ condition: "satisfied", not: false, measureThreshold: null }], action: "satisfied" },
  notSatisfied: {
    childActivitySet: "all",
    minimumCount: 0,
    minimumPercent: 0,
    combination: "all",
    conditions: [{ condition: "objectiveStatusKnown", not: false, measureThreshold: null }],
    action: "notSatisfied",
  },
  completed: { childActivitySet: "all", minimumCount: 0, minimumPercent: 0, combination: "all", conditions: [{ condition: "completed", not: false, measureThreshold: null }], action: "completed" },
  incomplete: { childActivitySet: "all", minimumCount: 0, minimumPercent: 0, combination: "all", conditions: [{ condition: "attempted", not: false, measureThreshold: null }], action: "incomplete" },
};

function childSetHolds(rule: RollupRule, values: Tri[]): boolean {
  if (!values.length) return false;
  const yes = values.filter((v) => v === true).length;
  switch (rule.childActivitySet) {
    case "all":
      return yes === values.length;
    case "any":
      return yes > 0;
    case "none":
      return values.every((v) => v === false);
    case "atLeastCount":
      return yes >= rule.minimumCount;
    case "atLeastPercent":
      return yes / values.length >= rule.minimumPercent - 1e-9;
  }
}

function ruleFires(rule: RollupRule, children: { node: SeqNode; status: ActivityStatus }[]) {
  return childSetHolds(
    rule,
    children.map(({ node, status }) => evalConditions(rule, node.seq, status, false)),
  );
}

/**
 * Rolls leaf statuses up the tree. Returns every activity's status by id. Children that are not
 * tracked, or that opt out of objective/progress rollup, don't contribute to that part.
 */
export function rollup(root: SeqNode, leaves: Map<string, ActivityStatus>): Map<string, ActivityStatus> {
  const out = new Map<string, ActivityStatus>();
  const visit = (node: SeqNode): ActivityStatus => {
    if (!node.children.length) {
      const s = (node.sco && leaves.get(node.sco)) || UNKNOWN_STATUS;
      out.set(node.id, s);
      return s;
    }
    const children = node.children.map((c) => ({ node: c, status: visit(c) }));
    // Each action uses the activity's own rules for it, or the default rule when it defines none.
    const rulesFor = (action: RollupAction) => {
      const own = node.seq.rollupRules.filter((r) => r.action === action);
      return own.length ? own : [DEFAULT_RULES[action]];
    };
    const tracked = children.filter((c) => c.node.seq.tracked);

    // Measure: weighted average of the children that have one.
    const measured = tracked.filter((c) => c.status.measure !== null && c.node.seq.objectiveMeasureWeight > 0);
    const weight = measured.reduce((sum, c) => sum + c.node.seq.objectiveMeasureWeight, 0);
    const measure = weight > 0 ? measured.reduce((sum, c) => sum + c.status.measure! * c.node.seq.objectiveMeasureWeight, 0) / weight : null;

    let satisfied: Tri = null;
    if (node.seq.satisfiedByMeasure && measure !== null) {
      satisfied = measure >= node.seq.minNormalizedMeasure;
    } else {
      const objective = tracked.filter((c) => c.node.seq.rollupObjectiveSatisfied);
      if (rulesFor("notSatisfied").some((r) => ruleFires(r, objective))) satisfied = false;
      if (rulesFor("satisfied").some((r) => ruleFires(r, objective))) satisfied = true;
    }

    let completed: Tri = null;
    const progress = tracked.filter((c) => c.node.seq.rollupProgressCompletion);
    if (rulesFor("incomplete").some((r) => ruleFires(r, progress))) completed = false;
    if (rulesFor("completed").some((r) => ruleFires(r, progress))) completed = true;

    const attempted = children.some((c) => c.status.attempted);
    const s: ActivityStatus = { attempted, completed: completed ?? (attempted ? false : null), satisfied, measure, attemptCount: attempted ? 1 : 0 };
    out.set(node.id, s);
    return s;
  };
  visit(root);
  return out;
}

/** The package attempt's overall status from the root's rolled-up status. */
export function rootStatus(s: ActivityStatus): "not attempted" | "incomplete" | "completed" | "passed" | "failed" {
  if (s.satisfied === true) return "passed";
  if (s.satisfied === false) return "failed";
  if (s.completed === true) return "completed";
  return s.attempted ? "incomplete" : "not attempted";
}

// ─── Navigation ─────────────────────────────────────────────────────────────

type Indexed = { parent: Map<string, SeqNode | null>; byId: Map<string, SeqNode>; leafBySco: Map<string, SeqNode> };

function index(root: SeqNode): Indexed {
  const parent = new Map<string, SeqNode | null>([[root.id, null]]);
  const byId = new Map<string, SeqNode>([[root.id, root]]);
  const leafBySco = new Map<string, SeqNode>();
  const walk = (n: SeqNode) => {
    for (const c of n.children) {
      parent.set(c.id, n);
      byId.set(c.id, c);
      if (c.sco && !c.children.length) leafBySco.set(c.sco, c);
      walk(c);
    }
  };
  walk(root);
  return { parent, byId, leafBySco };
}

const pathTo = (ix: Indexed, node: SeqNode) => {
  const path: SeqNode[] = [];
  for (let n: SeqNode | null | undefined = node; n; n = ix.parent.get(n.id)) path.unshift(n);
  return path;
};

export type NavItem = { identifier: string; title: string; available: boolean; hidden: boolean };
export type NavState = {
  items: NavItem[];
  /** SCO a "continue" request would deliver, if allowed. */
  continue: string | null;
  /** SCO a "previous" request would deliver, if allowed. */
  previous: string | null;
};

export class Sequencer {
  private ix: Indexed;
  private status: Map<string, ActivityStatus>;

  constructor(
    private readonly root: SeqNode,
    leaves: Map<string, ActivityStatus>,
    private readonly launchable: Set<string>,
  ) {
    this.ix = index(root);
    this.status = rollup(root, leaves);
  }

  statusOf(node: SeqNode) {
    return this.status.get(node.id) ?? UNKNOWN_STATUS;
  }

  get rootStatus() {
    return this.statusOf(this.root);
  }

  private pre(node: SeqNode, actions: string[]) {
    return firedRule(node.seq.preRules, actions, node.seq, this.statusOf(node));
  }

  /** Disabled by a pre-condition rule or its attempt limit (blocks delivery by any route). */
  private disabled(node: SeqNode) {
    return this.pre(node, ["disabled"]) === "disabled" || limitExceeded(node.seq, this.statusOf(node));
  }

  /** A leaf that can be delivered at all (exists, launchable, no disabled activity on its path). */
  private deliverable(leaf: SeqNode) {
    return !!leaf.sco && this.launchable.has(leaf.sco) && !pathTo(this.ix, leaf).some((n) => this.disabled(n));
  }

  /**
   * Whether a "choice" of this SCO is allowed from `current`: every cluster on the way allows
   * choice, nothing on the path is hidden from choice or disabled, choiceExit doesn't lock the
   * learner inside the current cluster, and no sibling between here and there stops forward traversal.
   */
  canChoose(sco: string, current: string | null): boolean {
    const leaf = this.ix.leafBySco.get(sco);
    if (!leaf || !this.deliverable(leaf)) return false;
    const path = pathTo(this.ix, leaf);
    if (path.slice(0, -1).some((n) => !n.seq.choice)) return false;
    if (path.some((n) => this.pre(n, ["hiddenFromChoice"]) === "hiddenFromChoice")) return false;
    const from = current ? this.ix.leafBySco.get(current) : undefined;
    if (!from || from === leaf) return true;
    const fromPath = pathTo(this.ix, from);
    // choiceExit=false: the learner can't leave that activity by choice.
    const common = fromPath.filter((n) => path.includes(n));
    const ancestorOfTarget = new Set(common.map((n) => n.id));
    if (fromPath.some((n) => !n.seq.choiceExit && !ancestorOfTarget.has(n.id))) return false;
    // stopForwardTraversal between the current activity and a later target, within their common parent.
    const parent = common[common.length - 1]!;
    const a = parent.children.indexOf(fromPath[common.length] ?? from);
    const b = parent.children.indexOf(path[common.length] ?? leaf);
    if (b > a) {
      for (let i = a; i < b; i++) {
        const sib = parent.children[i]!;
        if (this.pre(sib, ["stopForwardTraversal"]) === "stopForwardTraversal") return false;
      }
    }
    return true;
  }

  /** First deliverable leaf inside `node` walking in `dir` (flow must be enabled on clusters entered). */
  private enter(node: SeqNode, dir: 1 | -1): SeqNode | null | "blocked" {
    if (!node.children.length) return node.sco && this.launchable.has(node.sco) ? node : null;
    if (!node.seq.flow) return "blocked";
    const list = dir === 1 ? node.children : [...node.children].reverse();
    for (const c of list) {
      const r = this.step(c, dir);
      if (r === "skip") continue;
      return r;
    }
    return null;
  }

  /** Evaluates one candidate activity during flow traversal. */
  private step(node: SeqNode, dir: 1 | -1): SeqNode | "blocked" | "skip" {
    // stopForwardTraversal only constrains choice (SN SB.2.9), not flow.
    const action = this.pre(node, ["skip", "disabled"]);
    if (action === "skip") return "skip";
    if (action === "disabled" || limitExceeded(node.seq, this.statusOf(node))) return "blocked";
    const r = this.enter(node, dir);
    return r === null ? "skip" : r;
  }

  /** Flow from `from` (any activity) to the next/previous deliverable leaf, or null when not allowed. */
  flowFrom(from: SeqNode, dir: 1 | -1): SeqNode | null {
    let node = from;
    for (;;) {
      const parent = this.ix.parent.get(node.id);
      if (!parent) return null;
      if (!parent.seq.flow || (dir === -1 && parent.seq.forwardOnly)) return null;
      const siblings = parent.children;
      for (let i = siblings.indexOf(node) + dir; i >= 0 && i < siblings.length; i += dir) {
        const r = this.step(siblings[i]!, dir);
        if (r === "skip") continue;
        return r === "blocked" ? null : r;
      }
      node = parent;
    }
  }

  /** Where a start request (no current SCO) lands: flow into the tree, else the first choosable SCO. */
  start(prefer: (sco: string) => boolean = () => true): string | null {
    const flowed = this.enter(this.root, 1);
    if (flowed && flowed !== "blocked" && flowed.sco) {
      // Resume at the first unfinished activity along the flow path.
      for (let leaf: SeqNode | null = flowed; leaf; leaf = this.flowFrom(leaf, 1)) if (leaf.sco && prefer(leaf.sco)) return leaf.sco;
      return flowed.sco;
    }
    const all = [...this.ix.leafBySco.keys()];
    return all.find((s) => prefer(s) && this.canChoose(s, null)) ?? all.find((s) => this.canChoose(s, null)) ?? null;
  }

  /**
   * After the current SCO ends: exit-condition rules on its ancestors, then post-condition rules
   * from the exited activity upwards. `request` is the learner's (or SCO's) navigation request.
   * Returns the SCO to deliver next, "exit" to end the session, or null for "stay / let the learner choose".
   */
  afterExit(sco: string, request: "continue" | "previous" | null): string | "exit" | null {
    const leaf = this.ix.leafBySco.get(sco);
    if (!leaf) return null;
    let node: SeqNode = leaf;
    // Exit actions: the highest ancestor whose exit rule fires ends too.
    for (const anc of pathTo(this.ix, leaf).slice(0, -1)) {
      if (anc !== this.root && firedRule(anc.seq.exitRules, ["exit"], anc.seq, this.statusOf(anc)) === "exit") {
        node = anc;
        break;
      }
    }
    for (let guard = 0; guard < 64; guard++) {
      const action = firedRule(node.seq.postRules, ["exitParent", "exitAll", "retry", "retryAll", "continue", "previous"], node.seq, this.statusOf(node));
      if (action === "exitParent") {
        const parent = this.ix.parent.get(node.id);
        if (!parent) break;
        node = parent;
        continue;
      }
      if (action === "exitAll") return "exit";
      if (action === "retryAll") return this.firstLeaf(this.root);
      if (action === "retry") return this.firstLeaf(node);
      if (action === "continue" || action === "previous") request = action;
      break;
    }
    if (!request) return null;
    return this.flowFrom(node, request === "continue" ? 1 : -1)?.sco ?? null;
  }

  private firstLeaf(node: SeqNode): string | null {
    if (!node.children.length) return node.sco;
    const r = this.enter(node, 1);
    if (r && r !== "blocked") return r.sco;
    for (const c of node.children) {
      const s = this.firstLeaf(c);
      if (s) return s;
    }
    return null;
  }

  /** The navigation menu and continue/previous targets as seen from the current SCO. */
  nav(current: string | null, titles: Map<string, string>): NavState {
    const items: NavItem[] = [];
    for (const [sco, leaf] of this.ix.leafBySco) {
      if (!this.launchable.has(sco)) continue;
      const hidden = !leaf.visible || pathTo(this.ix, leaf).some((n) => this.pre(n, ["hiddenFromChoice"]) === "hiddenFromChoice");
      items.push({ identifier: sco, title: titles.get(sco) ?? leaf.title, available: sco === current || this.canChoose(sco, current), hidden });
    }
    const from = current ? this.ix.leafBySco.get(current) : undefined;
    return {
      items,
      continue: from ? (this.flowFrom(from, 1)?.sco ?? null) : null,
      previous: from ? (this.flowFrom(from, -1)?.sco ?? null) : null,
    };
  }
}
