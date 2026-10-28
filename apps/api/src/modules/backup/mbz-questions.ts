import type { BackupQuestion, RestoreReport } from "./format";
import { child, children, numberOf, path, textOf, type XmlNode } from "./xml";

/**
 * Moodle question bank (questions.xml) → our backup question bank.
 *
 * Handles both layouts: Moodle ≤ 3.11 (questions directly in a category) and 4.x
 * (question_bank_entries with versions). Supported types: multichoice, truefalse,
 * shortanswer, numerical, essay and match (→ matching). Others (random, calculated,
 * ddwtos …) are counted and reported. Quiz slots refer to questions by Moodle question
 * id (3.x) or question bank entry id (4.x); `slotKey` resolves both to our question id.
 */

type Category = { id: string; parentId: string | null; name: string; shared: boolean };
type Version = BackupQuestion["versions"][number];

export type MoodleQuestionBank = {
  categories: Category[];
  questions: BackupQuestion[];
  /** Moodle question id / "entry:<bank entry id>" → backup question id (+ version for pinned 4.x references). */
  refs: Map<string, { questionId: string; version: number | null }>;
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
  const bank: MoodleQuestionBank = { categories: [], questions: [], refs: new Map() };
  const root = child(doc, "question_categories");
  if (!root) return bank;
  const skipped = new Map<string, number>();
  const skip = (why: string) => skipped.set(why, (skipped.get(why) ?? 0) + 1);

  const version = (q: XmlNode, n: number): Version | null => {
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

/** Quiz slots from quiz.xml, resolved against the imported bank. */
export function moodleQuizSlots(quiz: XmlNode | null, bank: MoodleQuestionBank, report: RestoreReport, quizName: string) {
  const slots: { questionId: string; pinnedVersion: number | null; position: number; maxMark: number }[] = [];
  let missing = 0;
  for (const inst of children(child(quiz, "question_instances"), "question_instance")) {
    const position = numberOf(inst, "slot") ?? slots.length + 1;
    const maxMark = Math.max(0, numberOf(inst, "maxmark") ?? 1);
    const ref = child(inst, "question_reference");
    let hit: { questionId: string; version: number | null } | undefined;
    if (ref) {
      hit = bank.refs.get(`entry:${textOf(ref, "questionbankentryid")?.trim()}`);
      const pinned = numberOf(ref, "version");
      if (hit && pinned) hit = { ...hit, version: pinned };
    } else {
      const qid = textOf(inst, "questionid")?.trim() ?? textOf(inst, "question")?.trim();
      if (qid) hit = bank.refs.get(qid);
    }
    if (!hit) {
      missing++;
      continue;
    }
    slots.push({ questionId: hit.questionId, pinnedVersion: hit.version, position, maxMark });
  }
  if (missing) report.warnings.push(`Quiz "${quizName}": ${missing} question slot(s) (random or unsupported questions) were not imported`);
  return slots;
}
