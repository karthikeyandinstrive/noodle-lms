import type { BackupQuestion, RestoreReport } from "./format";
import { child, children, numberOf, path, textOf, type XmlNode } from "./xml";

/**
 * Moodle question bank (questions.xml) → our backup question bank.
 *
 * Handles both layouts: Moodle ≤ 3.11 (questions directly in a category) and 4.x
 * (question_bank_entries with versions). Supported types: multichoice, truefalse,
 * shortanswer, numerical, essay, match (→ matching), calculated and calculatedsimple
 * (→ calculated, with their dataset items), ddwtos and gapselect (→ gapselect). Random
 * questions become random quiz slots. Others (calculatedmulti, ddimageortext, ddmarker,
 * multianswer …) are counted and reported. Quiz slots refer to questions by Moodle question
 * id (3.x), question bank entry id (4.x) or a question set reference (4.x random slots).
 */

type Category = { id: string; parentId: string | null; name: string; shared: boolean };
type Version = BackupQuestion["versions"][number];

export type MoodleQuestionBank = {
  categories: Category[];
  questions: BackupQuestion[];
  /** Moodle question id / "entry:<bank entry id>" → backup question id (+ version for pinned 4.x references). */
  refs: Map<string, { questionId: string; version: number | null }>;
  /** Moodle 3.x "random" pseudo-questions by question id → the category they draw from. */
  randoms: Map<string, { categoryId: string; includeSubcategories: boolean }>;
};

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Option/answer texts are plain text in our model; Moodle stores HTML. */
export function plainText(html: string | null) {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

const clampFraction = (n: number | null) => Math.max(-1, Math.min(1, n ?? 0));

function answersOf(q: XmlNode, qtype: string) {
  return children(path(q, `plugin_qtype_${qtype}_question`, "answers"), "answer").map((a) => ({
    id: a.attrs.id ?? "",
    text: plainText(textOf(a, "answertext")),
    fraction: clampFraction(numberOf(a, "fraction")),
    feedback: plainText(textOf(a, "feedback")),
  }));
}

/** Type-specific data in our format, or a reason the question can't be imported. */
export function questionData(q: XmlNode): { type: string; data: Record<string, unknown> } | { skip: string } {
  const qtype = (textOf(q, "qtype") ?? "").trim();
  switch (qtype) {
    case "multichoice": {
      const opts = answersOf(q, qtype).filter((a) => a.text);
      const single = (numberOf(path(q, "plugin_qtype_multichoice_question", "multichoice"), "single") ?? 1) === 1;
      if (opts.length < 2) return { skip: "fewer than two options" };
      return {
        type: "multichoice",
        data: { single, options: opts.slice(0, 26).map((o, i) => ({ id: String.fromCharCode(97 + i), text: o.text.slice(0, 2000), fraction: o.fraction, feedback: o.feedback.slice(0, 2000) })) },
      };
    }
    case "truefalse": {
      const tf = path(q, "plugin_qtype_truefalse_question", "truefalse");
      const trueId = textOf(tf, "trueanswer")?.trim();
      const right = answersOf(q, qtype).find((a) => a.fraction >= 1);
      if (!right) return { skip: "no correct answer" };
      return { type: "truefalse", data: { correct: trueId ? right.id === trueId : /^true$/i.test(right.text) } };
    }
    case "shortanswer": {
      const answers = answersOf(q, qtype).filter((a) => a.text && a.fraction > 0);
      const usecase = numberOf(path(q, "plugin_qtype_shortanswer_question", "shortanswer"), "usecase") ?? 0;
      if (!answers.some((a) => a.fraction >= 1)) return { skip: "no answer worth 100%" };
      return { type: "shortanswer", data: { caseSensitive: usecase === 1, answers: answers.slice(0, 50).map((a) => ({ text: a.text.slice(0, 500), fraction: Math.min(1, a.fraction) })) } };
    }
    case "numerical": {
      const tolerance = new Map(
        children(path(q, "plugin_qtype_numerical_question", "numerical_records"), "numerical_record").map((r) => [textOf(r, "answer")?.trim() ?? "", numberOf(r, "tolerance") ?? 0]),
      );
      const answers = answersOf(q, qtype)
        .filter((a) => a.fraction > 0 && a.text !== "*" && Number.isFinite(Number(a.text)))
        .map((a) => ({ value: Number(a.text), tolerance: Math.abs(tolerance.get(a.id) ?? 0), fraction: Math.min(1, a.fraction) }));
      if (!answers.some((a) => a.fraction >= 1)) return { skip: "no numeric answer worth 100%" };
      return { type: "numerical", data: { answers: answers.slice(0, 50) } };
    }
    case "essay": {
      const essay = path(q, "plugin_qtype_essay_question", "essay");
      const template = plainText(textOf(essay, "responsetemplate"));
      return { type: "essay", data: template ? { responseTemplate: template.slice(0, 10_000) } : {} };
    }
    case "calculated":
    case "calculatedsimple": {
      const plugin = path(q, `plugin_qtype_${qtype}_question`);
      const records = new Map(children(child(plugin, "calculated_records"), "calculated_record").map((r) => [textOf(r, "answer")?.trim() ?? "", r]));
      const answers = answersOf(q, qtype)
        .filter((a) => a.text && a.fraction > 0)
        .map((a) => {
          const r = records.get(a.id);
          const tolType = numberOf(r, "tolerancetype") ?? 1;
          return {
            formula: a.text.slice(0, 1000),
            fraction: Math.min(1, a.fraction),
            tolerance: Math.abs(numberOf(r, "tolerance") ?? 0.01),
            toleranceType: tolType === 2 ? "nominal" : tolType === 3 ? "geometric" : "relative",
            answerDecimals: Math.max(0, Math.min(10, numberOf(r, "correctanswerlength") ?? 2)),
            answerFormat: numberOf(r, "correctanswerformat") === 2 ? "significant" : "decimals",
          };
        });
      if (!answers.some((a) => a.fraction >= 1)) return { skip: "no answer worth 100%" };
      const defs = children(child(plugin, "dataset_definitions"), "dataset_definition");
      const variables = defs
        .map((d) => {
          // options: "uniform:min:max:decimals" (or loguniform)
          const [, min, max, decimals] = (textOf(d, "options") ?? "").split(":");
          return { name: (textOf(d, "name") ?? "").trim(), min: Number(min ?? 1), max: Number(max ?? 10), decimals: Math.max(0, Math.min(10, Number(decimals ?? 1) || 0)) };
        })
        .filter((v) => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(v.name))
        .map((v) => ({ ...v, min: Number.isFinite(v.min) ? v.min : 1, max: Number.isFinite(v.max) && v.max >= v.min ? v.max : v.min }));
      if (!variables.length) return { skip: "no wildcards" };
      // Dataset items: set k takes item number k of every wildcard (only complete sets are kept).
      const items = defs.map((d) => new Map(children(child(d, "dataset_items"), "dataset_item").map((it) => [numberOf(it, "number") ?? 0, numberOf(it, "value")])));
      const count = Math.min(...items.map((m) => m.size));
      const datasets: Record<string, number>[] = [];
      for (let k = 1; k <= Math.min(count, 200); k++) {
        const set: Record<string, number> = {};
        defs.forEach((d, i) => {
          const v = items[i]!.get(k);
          if (v !== null && v !== undefined && Number.isFinite(v)) set[(textOf(d, "name") ?? "").trim()] = v;
        });
        if (variables.every((v) => v.name in set)) datasets.push(set);
      }
      return { type: "calculated", data: { answers: answers.slice(0, 20), variables: variables.slice(0, 20), datasets } };
    }
    case "ddwtos":
    case "gapselect": {
      const plugin = path(q, `plugin_qtype_${qtype}_question`);
      const choices = answersOf(q, qtype).map((a, i) => {
        const raw = children(child(plugin, "answers"), "answer")[i];
        const fb = textOf(raw, "feedback") ?? "";
        // gapselect stores the group number; ddwtos a serialized PHP object with "draggroup".
        const m = /draggroup";(?:s:\d+:"(\d+)"|i:(\d+))/.exec(fb);
        const group = Number(m?.[1] ?? m?.[2] ?? (/^\s*\d+\s*$/.test(fb) ? fb : 1)) || 1;
        return { text: a.text.slice(0, 500), group: Math.max(1, Math.min(20, group)) };
      });
      if (choices.length < 2 || choices.some((c) => !c.text)) return { skip: "fewer than two choices" };
      const shuffle = (numberOf(child(plugin, qtype), "shuffleanswers") ?? 1) === 1;
      return { type: "gapselect", data: { choices: choices.slice(0, 100), shuffle } };
    }
    case "match": {
      const pairs = children(path(q, "plugin_qtype_match_question", "matches"), "match")
        .map((m, i) => ({ id: `p${i + 1}`, question: plainText(textOf(m, "questiontext")).slice(0, 1000), answer: plainText(textOf(m, "answertext")).slice(0, 500) }))
        .filter((p) => p.answer);
      if (pairs.filter((p) => p.question).length < 2) return { skip: "fewer than two pairs" };
      return { type: "matching", data: { pairs: pairs.slice(0, 30) } };
    }
    default:
      return { skip: `type "${qtype || "unknown"}"` };
  }
}

export function parseMoodleQuestions(doc: XmlNode | null, report: RestoreReport): MoodleQuestionBank {
  const bank: MoodleQuestionBank = { categories: [], questions: [], refs: new Map(), randoms: new Map() };
  const root = child(doc, "question_categories");
  if (!root) return bank;
  const skipped = new Map<string, number>();
  const skip = (why: string) => skipped.set(why, (skipped.get(why) ?? 0) + 1);

  const version = (q: XmlNode, n: number): Version | null => {
    if ((textOf(q, "qtype") ?? "").trim() === "random") return null;
    const parsed = questionData(q);
    if ("skip" in parsed) {
      skip(parsed.skip);
      return null;
    }
    return {
      version: n,
      type: parsed.type,
      name: (textOf(q, "name") ?? "Question").trim().slice(0, 255) || "Question",
      text: textOf(q, "questiontext") ?? "",
      defaultMark: Math.max(0, numberOf(q, "defaultmark") ?? 1),
      data: parsed.data,
      generalFeedback: textOf(q, "generalfeedback"),
    };
  };

  const categoryIds = new Set(children(root, "question_category").map((c) => c.attrs.id ?? ""));
  for (const cat of children(root, "question_category")) {
    const id = cat.attrs.id ?? `cat-${bank.categories.length}`;
    const parent = textOf(cat, "parent")?.trim() ?? "0";
    const name = (textOf(cat, "name") ?? "Imported").trim();
    // Moodle 4's per-context "top" categories only hold other categories.
    bank.categories.push({ id, parentId: parent !== "0" && categoryIds.has(parent) ? parent : null, name: name.slice(0, 255) || "Imported", shared: false });

    // Moodle ≤ 3.11: questions directly in the category.
    for (const q of children(child(cat, "questions"), "question")) {
      if ((textOf(q, "parent") ?? "0").trim() !== "0") continue; // subquestions of cloze etc.
      if ((textOf(q, "qtype") ?? "").trim() === "random") {
        // Moodle 3.x random question: questiontext "1" means "include subcategories".
        if (q.attrs.id) bank.randoms.set(q.attrs.id, { categoryId: id, includeSubcategories: (textOf(q, "questiontext") ?? "").trim() === "1" });
        continue;
      }
      const v = version(q, 1);
      if (!v) continue;
      const qid = `q${q.attrs.id ?? bank.questions.length}`;
      bank.questions.push({ id: qid, categoryId: id, latestVersion: 1, versions: [v] });
      if (q.attrs.id) bank.refs.set(q.attrs.id, { questionId: qid, version: null });
    }

    // Moodle 4.x: bank entries with versions.
    for (const entry of children(child(cat, "question_bank_entries"), "question_bank_entry")) {
      const versions: Version[] = [];
      const qid = `e${entry.attrs.id ?? bank.questions.length}`;
      for (const qv of children(child(entry, "question_version"), "question_versions")) {
        const n = Math.max(1, numberOf(qv, "version") ?? versions.length + 1);
        for (const q of children(child(qv, "questions"), "question")) {
          const v = version(q, n);
          if (v) versions.push(v);
          if (q.attrs.id) bank.refs.set(q.attrs.id, { questionId: qid, version: n });
        }
      }
      if (!versions.length) continue;
      bank.questions.push({ id: qid, categoryId: id, latestVersion: Math.max(...versions.map((v) => v.version)), versions });
      if (entry.attrs.id) bank.refs.set(`entry:${entry.attrs.id}`, { questionId: qid, version: null });
    }
  }
  for (const [why, n] of skipped) report.unsupported.push(`${n} Moodle question${n === 1 ? "" : "s"} skipped (${why})`);
  return bank;
}

/** Category and "include subcategories" of a Moodle 4.x random slot's filter condition (4.0–4.2 and 4.3+ formats). */
export function randomFilter(json: string | null): { categoryId: string; includeSubcategories: boolean } | null {
  if (!json) return null;
  try {
    const f = JSON.parse(json) as {
      questioncategoryid?: string | number;
      includingsubcategories?: string | number | boolean;
      filter?: { category?: { values?: (string | number)[]; filteroptions?: { includesubcategories?: boolean | string | number } } };
    };
    const id = f.filter?.category?.values?.[0] ?? f.questioncategoryid;
    if (id === undefined || id === null || id === "") return null;
    const inc = f.filter?.category?.filteroptions?.includesubcategories ?? f.includingsubcategories;
    return { categoryId: String(id), includeSubcategories: inc === true || inc === 1 || inc === "1" || inc === "true" };
  } catch {
    return null;
  }
}

export type MoodleSlot =
  | { questionId: string; pinnedVersion: number | null; position: number; maxMark: number }
  | { questionId: null; randomCategoryId: string; randomIncludeSubcategories: boolean; position: number; maxMark: number };

/** Quiz slots from quiz.xml, resolved against the imported bank. */
export function moodleQuizSlots(quiz: XmlNode | null, bank: MoodleQuestionBank, report: RestoreReport, quizName: string) {
  const slots: MoodleSlot[] = [];
  const knownCategory = new Set(bank.categories.map((c) => c.id));
  let missing = 0;
  for (const inst of children(child(quiz, "question_instances"), "question_instance")) {
    const position = numberOf(inst, "slot") ?? slots.length + 1;
    const maxMark = Math.max(0, numberOf(inst, "maxmark") ?? 1);
    // Moodle 4.x random slot.
    const set = child(inst, "question_set_reference");
    if (set) {
      const random = randomFilter(textOf(set, "filtercondition"));
      if (random && knownCategory.has(random.categoryId)) {
        slots.push({ questionId: null, randomCategoryId: random.categoryId, randomIncludeSubcategories: random.includeSubcategories, position, maxMark });
      } else missing++;
      continue;
    }
    const ref = child(inst, "question_reference");
    let hit: { questionId: string; version: number | null } | undefined;
    if (ref) {
      hit = bank.refs.get(`entry:${textOf(ref, "questionbankentryid")?.trim()}`);
      const pinned = numberOf(ref, "version");
      if (hit && pinned) hit = { ...hit, version: pinned };
    } else {
      const qid = textOf(inst, "questionid")?.trim() ?? textOf(inst, "question")?.trim();
      const random = qid ? bank.randoms.get(qid) : undefined;
      if (random) {
        slots.push({ questionId: null, randomCategoryId: random.categoryId, randomIncludeSubcategories: random.includeSubcategories, position, maxMark });
        continue;
      }
      if (qid) hit = bank.refs.get(qid);
    }
    if (!hit) {
      missing++;
      continue;
    }
    slots.push({ questionId: hit.questionId, pinnedVersion: hit.version, position, maxMark });
  }
  if (missing) report.warnings.push(`Quiz "${quizName}": ${missing} question slot(s) (unsupported questions, or random questions from a category outside the backup) were not imported`);
  return slots;
}
