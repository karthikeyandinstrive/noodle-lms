import type { BackupCourse, RestoreReport } from "./format";
import { child, children, numberOf, textOf, type XmlNode } from "./xml";

/**
 * Moodle gradebook setup (gradebook.xml) → our gradebook categories and items.
 *
 * Imported: the category tree with aggregation and "drop lowest", the course total, category,
 * activity and manual grade items with their range, pass grade, weight, hidden/locked flags and
 * order. Activity items are matched to imported activities by module type + instance id.
 * Not imported (reported): calculated items (formulas), scales, outcomes, "keep highest", and
 * per-user grades (user data is never read from .mbz files).
 */

type Gradebook = BackupCourse["gradebook"];

/** Moodle GRADE_AGGREGATE_* constants → our aggregations (approximations are reported). */
const AGGREGATION: Record<number, { to: Gradebook["categories"][number]["aggregation"]; approx?: string }> = {
  0: { to: "mean" },
  2: { to: "median" },
  4: { to: "lowest" },
  6: { to: "highest" },
  8: { to: "mean", approx: "mode of grades" },
  10: { to: "weighted_mean" },
  11: { to: "weighted_mean", approx: "simple weighted mean (weights now follow the item weights)" },
  12: { to: "mean", approx: "mean with extra credits" },
  13: { to: "sum" },
};

const NULL = "$@NULL@$";
const idOf = (node: XmlNode | null, name: string) => {
  const v = textOf(node, name)?.trim();
  return v && v !== NULL && v !== "0" ? v : null;
};

/**
 * `activityFor(module, instanceId)` returns the imported activity id (Moodle course module id)
 * for a Moodle activity instance, or null when that activity wasn't imported.
 */
export function parseMoodleGradebook(doc: XmlNode | null, activityFor: (module: string, instanceId: string) => string | null, report: RestoreReport): Gradebook {
  const book: Gradebook = { categories: [], items: [] };
  const root = child(doc, "gradebook");
  if (!root) return book;

  const cats = children(child(root, "grade_categories"), "grade_category");
  const catIds = new Set(cats.map((c) => c.attrs.id ?? ""));
  const aggregationOf = new Map<string, number>();
  const parentOf = new Map<string, string | null>();
  const approx = new Set<string>();
  let keepHigh = 0;
  for (const c of cats) {
    const id = c.attrs.id;
    if (!id) continue;
    const parent = idOf(c, "parent");
    const code = numberOf(c, "aggregation") ?? 13;
    aggregationOf.set(id, code);
    parentOf.set(id, parent);
    const agg = AGGREGATION[code] ?? { to: "weighted_mean" as const, approx: `aggregation type ${code}` };
    if (agg.approx) approx.add(agg.approx);
    if ((numberOf(c, "keephigh") ?? 0) > 0) keepHigh++;
    const name = (textOf(c, "fullname") ?? "").trim();
    book.categories.push({
      id,
      parentId: parent && catIds.has(parent) ? parent : null,
      name: (!parent ? "Course total" : name && name !== "?" ? name : "Category").slice(0, 255),
      aggregation: agg.to,
      dropLowest: Math.max(0, Math.min(1000, Math.trunc(numberOf(c, "droplow") ?? 0))),
    });
  }

  let calculated = 0;
  let scales = 0;
  let skipped = 0;
  for (const it of children(child(root, "grade_items"), "grade_item")) {
    const id = it.attrs.id;
    if (!id) continue;
    const type = (textOf(it, "itemtype") ?? "").trim();
    const gradeType = numberOf(it, "gradetype") ?? 1;
    if (gradeType === 0 || gradeType === 3) continue; // "none" / text-only items carry no grade
    if (gradeType === 2) scales++;
    if ((textOf(it, "calculation") ?? "").trim() && textOf(it, "calculation")!.trim() !== NULL) calculated++;
    if ((textOf(it, "itemnumber") ?? "0").trim() !== "0" && type === "mod") {
      skipped++; // secondary grade items of an activity (e.g. forum whole-forum grading)
      continue;
    }

    // Weight: the coefficient that matters depends on the parent category's aggregation.
    // Category and course items name the category they total in `iteminstance`; others their parent in `categoryid`.
    const parentCat = type === "category" || type === "course" ? idOf(it, "iteminstance") : idOf(it, "categoryid");
    const aggregatedIn = type === "category" ? (parentCat ? parentOf.get(parentCat) : null) : parentCat;
    const parentAgg = aggregatedIn ? aggregationOf.get(aggregatedIn) : undefined;
    const coef = numberOf(it, "aggregationcoef") ?? 0;
    const coef2 = numberOf(it, "aggregationcoef2") ?? 0;
    let weight = 1;
    if (parentAgg === 10 && coef > 0) weight = coef;
    else if (parentAgg === 13 && (numberOf(it, "weightoverride") ?? 0) === 1 && coef2 > 0) weight = coef2 * 100;

    const max = gradeType === 2 ? 100 : (numberOf(it, "grademax") ?? 100);
    const min = gradeType === 2 ? 0 : (numberOf(it, "grademin") ?? 0);
    const pass = numberOf(it, "gradepass") ?? 0;
    const base = {
      id,
      name: (textOf(it, "itemname") ?? "").trim().slice(0, 255),
      gradeMax: max > min ? max : min + 1,
      gradeMin: min,
      gradePass: pass > 0 ? pass : null,
      weight,
      hidden: (numberOf(it, "hidden") ?? 0) !== 0,
      locked: (numberOf(it, "locked") ?? 0) !== 0,
      position: Math.trunc(numberOf(it, "sortorder") ?? book.items.length),
    };

    if (type === "course") {
      book.items.push({ ...base, categoryId: null, type: "course", activityId: null, name: "Course total" });
    } else if (type === "category") {
      if (!parentCat || !catIds.has(parentCat)) continue;
      book.items.push({ ...base, categoryId: parentCat, type: "category", activityId: null, name: base.name || "Category total" });
    } else if (type === "mod") {
      const activityId = activityFor((textOf(it, "itemmodule") ?? "").trim(), (textOf(it, "iteminstance") ?? "").trim());
      if (!activityId) continue; // the activity itself wasn't imported (already reported)
      book.items.push({ ...base, categoryId: parentCat && catIds.has(parentCat) ? parentCat : null, type: "activity", activityId });
    } else if (type === "manual") {
      book.items.push({ ...base, categoryId: parentCat && catIds.has(parentCat) ? parentCat : null, type: "manual", activityId: null, name: base.name || "Manual item" });
    }
  }

  for (const a of approx) report.warnings.push(`Gradebook: Moodle aggregation "${a}" was approximated`);
  if (keepHigh) report.warnings.push(`Gradebook: "keep highest" on ${keepHigh} categor${keepHigh === 1 ? "y" : "ies"} is not supported and was ignored`);
  if (calculated) report.unsupported.push(`${calculated} calculated grade item${calculated === 1 ? "" : "s"} (formulas are not imported; the items aggregate normally)`);
  if (scales) report.warnings.push(`Gradebook: ${scales} item${scales === 1 ? "" : "s"} graded with a Moodle scale were imported as 0–100 points`);
  if (skipped) report.unsupported.push(`${skipped} secondary activity grade item${skipped === 1 ? "" : "s"}`);
  return book;
}
