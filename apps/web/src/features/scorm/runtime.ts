/**
 * Browser-side SCORM run-time: the API objects a SCO finds as `window.API` (SCORM 1.2)
 * or `window.API_1484_11` (SCORM 2004) on the player page. The CMI lives in memory;
 * changed elements are committed to the server on Commit/Finish and on pagehide.
 *
 * Value rules mirror the server's whitelist (apps/api/src/modules/scorm/cmi.ts), which
 * re-validates everything: the client checks only exist to return the right error codes.
 */

export type ScormVersion = "1.2" | "2004";
export type Cmi = Record<string, string>;

const el = (path: string) => new RegExp(`^${path.split(".").map((p) => (p === "n" ? "\\d{1,3}" : p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("\\.")}$`);
const rx = (re: RegExp) => (v: string) => re.test(v);
const oneOf = (...values: string[]) => (v: string) => values.includes(v);
const maxLen = (n: number) => (v: string) => v.length <= n;
const decimal = (min = -Infinity, max = Infinity, allowBlank = false) => (v: string) => {
  if (v === "") return allowBlank;
  if (!/^-?\d+(\.\d+)?$/.test(v.trim())) return false;
  const n = Number(v);
  return n >= min && n <= max;
};
const integer = (min: number, max: number) => (v: string) => /^-?\d+$/.test(v) && Number(v) >= min && Number(v) <= max;
const timespan12 = rx(/^\d{2,4}:[0-5]\d:[0-5]\d(\.\d{1,2})?$/);
const time12 = rx(/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,2})?$/);
const duration = (v: string) => /^P(?:\d+Y)?(?:\d+M)?(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d{1,2})?S)?)?$/.test(v) && v !== "P" && !v.endsWith("T");
const timestamp = rx(/^\d{4}(-\d{2}(-\d{2}(T\d{2}(:\d{2}(:\d{2}(\.\d{1,2})?)?)?(Z|[+-]\d{2}(:\d{2})?)?)?)?)?$/);
const id = (max: number) => (v: string) => v.length >= 1 && v.length <= max;

type Rule = [RegExp, (v: string) => boolean];

const STATUS_12 = ["passed", "completed", "failed", "incomplete", "browsed"];
const RULES: Record<ScormVersion, Rule[]> = {
  "1.2": [
    [el("cmi.core.lesson_location"), maxLen(255)],
    [el("cmi.core.lesson_status"), oneOf(...STATUS_12)],
    [el("cmi.core.score.raw"), decimal(0, 100, true)],
    [el("cmi.core.score.max"), decimal(0, 100, true)],
    [el("cmi.core.score.min"), decimal(0, 100, true)],
    [el("cmi.core.exit"), oneOf("time-out", "suspend", "logout", "")],
    [el("cmi.core.session_time"), timespan12],
    [el("cmi.suspend_data"), maxLen(4096)],
    [el("cmi.comments"), maxLen(4096)],
    [el("cmi.objectives.n.id"), id(255)],
    [el("cmi.objectives.n.score.raw"), decimal(0, 100, true)],
    [el("cmi.objectives.n.score.max"), decimal(0, 100, true)],
    [el("cmi.objectives.n.score.min"), decimal(0, 100, true)],
    [el("cmi.objectives.n.status"), oneOf(...STATUS_12, "not attempted")],
    [el("cmi.student_preference.audio"), integer(-1, 100)],
    [el("cmi.student_preference.language"), maxLen(255)],
    [el("cmi.student_preference.speed"), integer(-100, 100)],
    [el("cmi.student_preference.text"), integer(-1, 1)],
    [el("cmi.interactions.n.id"), id(255)],
    [el("cmi.interactions.n.objectives.n.id"), id(255)],
    [el("cmi.interactions.n.time"), time12],
    [el("cmi.interactions.n.type"), oneOf("true-false", "choice", "fill-in", "matching", "performance", "sequencing", "likert", "numeric")],
    [el("cmi.interactions.n.correct_responses.n.pattern"), maxLen(255)],
    [el("cmi.interactions.n.weighting"), decimal()],
    [el("cmi.interactions.n.student_response"), maxLen(255)],
    [el("cmi.interactions.n.result"), (v) => ["correct", "wrong", "unanticipated", "neutral"].includes(v) || decimal()(v)],
    [el("cmi.interactions.n.latency"), timespan12],
  ],
  "2004": [
    [el("cmi.comments_from_learner.n.comment"), maxLen(4000)],
    [el("cmi.comments_from_learner.n.location"), maxLen(250)],
    [el("cmi.comments_from_learner.n.timestamp"), timestamp],
    [el("cmi.completion_status"), oneOf("completed", "incomplete", "not attempted", "unknown")],
    [el("cmi.exit"), oneOf("time-out", "suspend", "logout", "normal", "")],
    [el("cmi.interactions.n.id"), id(4000)],
    [el("cmi.interactions.n.type"), oneOf("true-false", "choice", "fill-in", "long-fill-in", "matching", "performance", "sequencing", "likert", "numeric", "other")],
    [el("cmi.interactions.n.objectives.n.id"), id(4000)],
    [el("cmi.interactions.n.timestamp"), timestamp],
    [el("cmi.interactions.n.correct_responses.n.pattern"), maxLen(8000)],
    [el("cmi.interactions.n.weighting"), decimal()],
    [el("cmi.interactions.n.learner_response"), maxLen(8000)],
    [el("cmi.interactions.n.result"), (v) => ["correct", "incorrect", "unanticipated", "neutral"].includes(v) || decimal()(v)],
    [el("cmi.interactions.n.latency"), duration],
    [el("cmi.interactions.n.description"), maxLen(500)],
    [el("cmi.learner_preference.audio_level"), decimal(0)],
    [el("cmi.learner_preference.language"), maxLen(250)],
    [el("cmi.learner_preference.delivery_speed"), decimal(0)],
    [el("cmi.learner_preference.audio_captioning"), oneOf("-1", "0", "1")],
    [el("cmi.location"), maxLen(1000)],
    [el("cmi.objectives.n.id"), id(4000)],
    [el("cmi.objectives.n.score.scaled"), decimal(-1, 1)],
    [el("cmi.objectives.n.score.raw"), decimal()],
    [el("cmi.objectives.n.score.min"), decimal()],
    [el("cmi.objectives.n.score.max"), decimal()],
    [el("cmi.objectives.n.success_status"), oneOf("passed", "failed", "unknown")],
    [el("cmi.objectives.n.completion_status"), oneOf("completed", "incomplete", "not attempted", "unknown")],
    [el("cmi.objectives.n.progress_measure"), decimal(0, 1)],
    [el("cmi.objectives.n.description"), maxLen(250)],
    [el("cmi.progress_measure"), decimal(0, 1)],
    [el("cmi.score.scaled"), decimal(-1, 1)],
    [el("cmi.score.raw"), decimal()],
    [el("cmi.score.min"), decimal()],
    [el("cmi.score.max"), decimal()],
    [el("cmi.session_time"), duration],
    [el("cmi.success_status"), oneOf("passed", "failed", "unknown")],
    [el("cmi.suspend_data"), maxLen(64_000)],
    [el("adl.nav.request"), rx(/^(continue|previous|exit|exitAll|abandon|abandonAll|suspendAll|_none_|\{target=[^}]{1,4000}\}(choice|jump))$/)],
  ],
};

const WRITE_ONLY: Record<ScormVersion, RegExp[]> = {
  "1.2": [/^cmi\.core\.exit$/, /^cmi\.core\.session_time$/, /^cmi\.interactions\.\d+\.(id|time|type|weighting|student_response|result|latency|objectives\.\d+\.id|correct_responses\.\d+\.pattern)$/],
  "2004": [/^cmi\.exit$/, /^cmi\.session_time$/],
};

const CHILDREN: Record<ScormVersion, Record<string, string>> = {
  "1.2": {
    "cmi.core._children": "student_id,student_name,lesson_location,credit,lesson_status,entry,score,total_time,lesson_mode,exit,session_time",
    "cmi.core.score._children": "raw,min,max",
    "cmi.objectives._children": "id,score,status",
    "cmi.student_data._children": "mastery_score,max_time_allowed,time_limit_action",
    "cmi.student_preference._children": "audio,language,speed,text",
    "cmi.interactions._children": "id,objectives,time,type,correct_responses,weighting,student_response,result,latency",
  },
  "2004": {
    "cmi.comments_from_learner._children": "comment,location,timestamp",
    "cmi.comments_from_lms._children": "comment,location,timestamp",
    "cmi.interactions._children": "id,type,objectives,timestamp,correct_responses,weighting,learner_response,result,latency,description",
    "cmi.objectives._children": "id,score,success_status,completion_status,progress_measure,description",
    "cmi.score._children": "scaled,raw,min,max",
    "cmi.learner_preference._children": "audio_level,language,delivery_speed,audio_captioning",
  },
};

const COLLECTIONS: Record<ScormVersion, string[]> = {
  "1.2": ["cmi.objectives", "cmi.interactions"],
  "2004": ["cmi.objectives", "cmi.interactions", "cmi.comments_from_learner", "cmi.comments_from_lms"],
};

const MAX_INDEX: Record<string, number> = { "cmi.objectives": 100, "cmi.interactions": 250, "cmi.comments_from_learner": 100 };

const ERRORS_12: Record<string, string> = {
  "0": "No error",
  "101": "General exception",
  "201": "Invalid argument error",
  "202": "Element cannot have children",
  "203": "Element not an array - cannot have count",
  "301": "Not initialized",
  "401": "Not implemented error",
  "402": "Invalid set value, element is a keyword",
  "403": "Element is read only",
  "404": "Element is write only",
  "405": "Incorrect data type",
};

const ERRORS_2004: Record<string, string> = {
  "0": "No Error",
  "101": "General Exception",
  "102": "General Initialization Failure",
  "103": "Already Initialized",
  "104": "Content Instance Terminated",
  "111": "General Termination Failure",
  "112": "Termination Before Initialization",
  "113": "Termination After Termination",
  "122": "Retrieve Data Before Initialization",
  "123": "Retrieve Data After Termination",
  "132": "Store Data Before Initialization",
  "133": "Store Data After Termination",
  "142": "Commit Before Initialization",
  "143": "Commit After Termination",
  "201": "General Argument Error",
  "301": "General Get Failure",
  "351": "General Set Failure",
  "391": "General Commit Failure",
  "401": "Undefined Data Model Element",
  "402": "Unimplemented Data Model Element",
  "403": "Data Model Element Value Not Initialized",
  "404": "Data Model Element Is Read Only",
  "405": "Data Model Element Is Write Only",
  "406": "Data Model Element Type Mismatch",
  "407": "Data Model Element Value Out Of Range",
  "408": "Data Model Dependency Not Established",
};

export type CommitFn = (cmi: Cmi, opts: { finish: boolean; keepalive: boolean }) => Promise<void>;

type State = "new" | "running" | "terminated";

/** In-memory CMI + SCORM API semantics shared by the 1.2 and 2004 adapters. */
export class ScormSession {
  private state: State = "new";
  private lastError = "0";
  private dirty = new Map<string, string>();
  private chain: Promise<void> = Promise.resolve();
  readonly values: Cmi;

  constructor(
    readonly version: ScormVersion,
    initial: Cmi,
    private readonly commitFn: CommitFn | null,
    private readonly onError?: (err: unknown) => void,
  ) {
    this.values = { ...initial };
  }

  get errors() {
    return this.version === "1.2" ? ERRORS_12 : ERRORS_2004;
  }

  private ok(value = "true") {
    this.lastError = "0";
    return value;
  }

  private fail(code: string, value = "false") {
    this.lastError = code;
    return value;
  }

  private count(prefix: string) {
    const re = new RegExp(`^${prefix.replace(/\./g, "\\.")}\\.(\\d+)\\.`);
    let max = -1;
    for (const k of Object.keys(this.values)) {
      const m = re.exec(k);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return max + 1;
  }

  /** Counts for nested collections, e.g. cmi.interactions.0.objectives._count. */
  private countOf(key: string) {
    return this.count(key.slice(0, -"._count".length));
  }

  private isKnown(key: string) {
    return RULES[this.version].some(([re]) => re.test(key)) || key in this.values || key in CHILDREN[this.version];
  }

  initialize(arg: string) {
    const v12 = this.version === "1.2";
    if (arg !== "") return this.fail("201");
    if (this.state === "running") return this.fail(v12 ? "101" : "103");
    if (this.state === "terminated") return this.fail(v12 ? "101" : "104");
    this.state = "running";
    return this.ok();
  }

  terminate(arg: string) {
    const v12 = this.version === "1.2";
    if (arg !== "") return this.fail("201");
    if (this.state === "new") return this.fail(v12 ? "301" : "112");
    if (this.state === "terminated") return this.fail(v12 ? "101" : "113");
    // SCORM 1.2 RTE: a status still "not attempted" at LMSFinish becomes completed (browsed in browse mode).
    if (v12 && this.values["cmi.core.lesson_status"] === "not attempted") {
      const status = this.values["cmi.core.lesson_mode"] === "browse" ? "browsed" : "completed";
      this.values["cmi.core.lesson_status"] = status;
      this.dirty.set("cmi.core.lesson_status", status);
    }
    this.state = "terminated";
    void this.flush(true, false);
    return this.ok();
  }

  getValue(key: string) {
    const v12 = this.version === "1.2";
    if (this.state === "new") return this.fail(v12 ? "301" : "122", "");
    if (this.state === "terminated" && !v12) return this.fail("123", "");
    if (!key) return this.fail(v12 ? "201" : "301", "");
    const children = CHILDREN[this.version][key];
    if (children !== undefined) return this.ok(children);
    if (key.endsWith("._children")) return this.fail(v12 ? "202" : "301", "");
    if (key.endsWith("._count")) {
      const base = key.slice(0, -"._count".length);
      const isCollection = COLLECTIONS[this.version].includes(base) || /\.(objectives|correct_responses)$/.test(base);
      return isCollection ? this.ok(String(this.countOf(key))) : this.fail(v12 ? "203" : "301", "");
    }
    if (WRITE_ONLY[this.version].some((re) => re.test(key))) return this.fail(v12 ? "404" : "405", "");
    if (!this.isKnown(key)) return this.fail(v12 ? "201" : "401", "");
    const value = this.values[key];
    if (value === undefined) {
      // 2004: an element that exists in the model but was never set.
      return v12 ? this.ok("") : this.fail("403", "");
    }
    return this.ok(value);
  }

  setValue(key: string, raw: unknown) {
    const v12 = this.version === "1.2";
    if (this.state === "new") return this.fail(v12 ? "301" : "132");
    if (this.state === "terminated") return this.fail(v12 ? "101" : "133");
    if (!key) return this.fail(v12 ? "201" : "351");
    const value = String(raw ?? "");
    if (key.endsWith("._children") || key.endsWith("._count") || key === "cmi._version") return this.fail(v12 ? "402" : "404");
    const rule = RULES[this.version].find(([re]) => re.test(key));
    if (!rule) {
      // Read-only elements are all present in the initial data handed over by the server.
      return key in this.values ? this.fail(v12 ? "403" : "404") : this.fail(v12 ? "201" : "401");
    }
    // Collections must be filled in order (no gaps), and are bounded.
    for (const coll of COLLECTIONS[this.version]) {
      const m = new RegExp(`^${coll.replace(/\./g, "\\.")}\\.(\\d+)\\.`).exec(key);
      if (!m) continue;
      const n = Number(m[1]);
      if (n > this.count(coll) || n >= (MAX_INDEX[coll] ?? 100)) return this.fail(v12 ? "201" : "351");
      if (!v12 && !key.endsWith(".id") && this.values[`${coll}.${n}.id`] === undefined && coll !== "cmi.comments_from_learner") return this.fail("408");
    }
    if (!rule[1](value)) {
      const numeric = /score|progress_measure|weighting|audio|speed|text|delivery|level/.test(key);
      return this.fail(v12 ? "405" : numeric && /^-?\d+(\.\d+)?$/.test(value) ? "407" : "406");
    }
    const stored = v12 && key === "cmi.comments" ? ((this.values[key] ?? "") + value).slice(-4096) : value;
    this.values[key] = stored;
    this.dirty.set(key, value);
    return this.ok();
  }

  commit(arg: string) {
    const v12 = this.version === "1.2";
    if (arg !== "") return this.fail("201");
    if (this.state === "new") return this.fail(v12 ? "301" : "142");
    if (this.state === "terminated") return this.fail(v12 ? "101" : "143");
    void this.flush(false, false);
    return this.ok();
  }

  getLastError() {
    return this.lastError;
  }

  getErrorString(code: unknown) {
    return this.errors[String(code ?? "")] ?? "";
  }

  getDiagnostic(code: unknown) {
    const c = String(code ?? "") || this.lastError;
    return this.errors[c] ?? "";
  }

  get running() {
    return this.state === "running";
  }

  /** Sends changed elements (serialized, so commits arrive in order). */
  flush(finish: boolean, keepalive: boolean) {
    if (!this.commitFn) return Promise.resolve();
    if (!this.dirty.size && !finish) return this.chain;
    const batch = Object.fromEntries(this.dirty);
    // 1.2 comments are appended server-side: send each chunk once.
    this.dirty.clear();
    const send = () =>
      this.commitFn!(batch, { finish, keepalive }).catch((err: unknown) => {
        // Re-queue what failed unless newer values were set meanwhile.
        for (const [k, v] of Object.entries(batch)) if (!this.dirty.has(k)) this.dirty.set(k, v);
        this.onError?.(err);
      });
    // pagehide: send right away (the page may be gone before the chain resolves).
    this.chain = keepalive ? send() : this.chain.then(send);
    return this.chain;
  }

  /**
   * Called when the player page is hidden or unmounted. `finish` folds the session time
   * server-side; pass false when the page may come back (bfcache), so time is not counted twice.
   */
  pageHide(finish: boolean) {
    if (this.state === "running") void this.flush(finish, true);
  }
}

const call = (fn: () => string) => {
  try {
    return fn();
  } catch {
    return "false";
  }
};

export function api12(s: ScormSession) {
  return {
    LMSInitialize: (a = "") => call(() => s.initialize(String(a))),
    LMSFinish: (a = "") => call(() => s.terminate(String(a))),
    LMSGetValue: (k: string) => call(() => s.getValue(String(k ?? ""))),
    LMSSetValue: (k: string, v: unknown) => call(() => s.setValue(String(k ?? ""), v)),
    LMSCommit: (a = "") => call(() => s.commit(String(a))),
    LMSGetLastError: () => s.getLastError(),
    LMSGetErrorString: (c: unknown) => s.getErrorString(c),
    LMSGetDiagnostic: (c: unknown) => s.getDiagnostic(c),
  };
}

export function api2004(s: ScormSession) {
  return {
    version: "1.0",
    Initialize: (a = "") => call(() => s.initialize(String(a))),
    Terminate: (a = "") => call(() => s.terminate(String(a))),
    GetValue: (k: string) => call(() => s.getValue(String(k ?? ""))),
    SetValue: (k: string, v: unknown) => call(() => s.setValue(String(k ?? ""), v)),
    Commit: (a = "") => call(() => s.commit(String(a))),
    GetLastError: () => s.getLastError(),
    GetErrorString: (c: unknown) => s.getErrorString(c),
    GetDiagnostic: (c: unknown) => s.getDiagnostic(c),
  };
}
