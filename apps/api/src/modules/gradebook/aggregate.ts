/**
 * Pure gradebook aggregation (Moodle "grade categories" maths). No database access,
 * so it is unit-tested in isolation (aggregate.test.ts).
 *
 *  - Every child grade is normalised to a percentage of its own range (min..max).
 *  - Empty (null) grades are ignored ("aggregate only non-empty grades").
 *  - `dropLowest` removes the N lowest percentages before aggregating (at least one grade is kept).
 *  - A category's result is a percentage; it becomes a child entry of its parent category with the
 *    weight of the category's grade item. The root category's result is the course total.
 */

export const AGGREGATIONS = ["mean", "weighted_mean", "sum", "highest", "lowest", "median"] as const;
export type Aggregation = (typeof AGGREGATIONS)[number];

export type AggEntry = { grade: number | null; min: number; max: number; weight: number };

const round5 = (n: number) => Math.round(n * 100_000) / 100_000;

/** Grade → percentage of the item's range, clamped to 0..100. null for empty grades or empty ranges. */
export function toPercent(grade: number | null, min: number, max: number): number | null {
  if (grade === null || !Number.isFinite(grade) || max <= min) return null;
  return Math.max(0, Math.min(100, ((grade - min) / (max - min)) * 100));
}

/** Percentage → grade in an item's own scale. */
export function fromPercent(pct: number | null, min: number, max: number): number | null {
  if (pct === null) return null;
  return round5(min + (pct / 100) * (max - min));
}

/** Aggregates child entries into a percentage (0..100), or null when nothing is graded. */
export function aggregate(method: Aggregation, entries: AggEntry[], dropLowest = 0): number | null {
  let graded = entries
    .map((e) => ({ ...e, pct: toPercent(e.grade, e.min, e.max) }))
    .filter((e): e is AggEntry & { pct: number } => e.pct !== null);
  if (!graded.length) return null;

  if (dropLowest > 0) {
    graded = [...graded].sort((a, b) => a.pct - b.pct).slice(Math.min(dropLowest, graded.length - 1));
  }
  const pcts = graded.map((e) => e.pct);

  let result: number | null;
  switch (method) {
    case "mean":
      result = pcts.reduce((s, p) => s + p, 0) / pcts.length;
      break;
    case "weighted_mean": {
      const totalWeight = graded.reduce((s, e) => s + Math.max(0, e.weight), 0);
      result = totalWeight > 0 ? graded.reduce((s, e) => s + e.pct * Math.max(0, e.weight), 0) / totalWeight : null;
      break;
    }
    case "sum": {
      // Natural: points earned over points available (in each item's own scale).
      const earned = graded.reduce((s, e) => s + (Math.max(e.min, Math.min(e.max, e.grade!)) - e.min), 0);
      const available = graded.reduce((s, e) => s + (e.max - e.min), 0);
      result = available > 0 ? (earned / available) * 100 : null;
      break;
    }
    case "highest":
      result = Math.max(...pcts);
      break;
    case "lowest":
      result = Math.min(...pcts);
      break;
    case "median": {
      const sorted = [...pcts].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      result = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
      break;
    }
  }
  return result === null ? null : round5(result);
}

// ─── Category tree ──────────────────────────────────────────────────────────

export type TreeCategory = { id: string; parentId: string | null; aggregation: Aggregation; dropLowest: number };
export type TreeItem = {
  id: string;
  type: "activity" | "manual" | "category" | "course";
  /** Leaf items: the category containing them. Category items: the category they total. Course item: the root. */
  categoryId: string | null;
  gradeMin: number;
  gradeMax: number;
  weight: number;
};

/**
 * Computes the category and course totals of one learner.
 *
 * @param grades  final grades of leaf items (activity/manual), by item id
 * @param fixed   category/course items whose grade must not be recalculated (overridden or locked),
 *                with their current grade — used as-is, including as an input to the parent category
 * @returns       new grades for every category/course item that is not fixed, in the item's own scale
 */
export function computeTotals(
  categories: TreeCategory[],
  items: TreeItem[],
  grades: Map<string, number | null>,
  fixed: Map<string, number | null> = new Map(),
): Map<string, number | null> {
  const out = new Map<string, number | null>();
  const root = categories.find((c) => c.parentId === null);
  if (!root) return out;
  const known = new Set(categories.map((c) => c.id));

  const totalItemOf = new Map<string, TreeItem>();
  for (const it of items) {
    if (it.type === "course" && !totalItemOf.has(root.id)) totalItemOf.set(root.id, it);
    else if (it.type === "category" && it.categoryId && it.categoryId !== root.id) totalItemOf.set(it.categoryId, it);
  }
  const leavesOf = new Map<string, TreeItem[]>();
  for (const it of items) {
    if (it.type !== "activity" && it.type !== "manual") continue;
    // Items whose category was deleted belong to the root.
    const cat = it.categoryId && known.has(it.categoryId) ? it.categoryId : root.id;
    leavesOf.set(cat, [...(leavesOf.get(cat) ?? []), it]);
  }
  const childrenOf = new Map<string, TreeCategory[]>();
  for (const c of categories) {
    if (c.parentId === null) continue;
    const parent = known.has(c.parentId) ? c.parentId : root.id;
    childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), c]);
  }

  const visiting = new Set<string>();
  /** Returns the category's percentage (0..100). */
  const visit = (cat: TreeCategory): number | null => {
    if (visiting.has(cat.id)) return null; // corrupt tree (cycle) — ignore the loop
    visiting.add(cat.id);
    const entries: AggEntry[] = (leavesOf.get(cat.id) ?? []).map((it) => ({
      grade: grades.get(it.id) ?? null,
      min: it.gradeMin,
      max: it.gradeMax,
      weight: it.weight,
    }));
    for (const child of childrenOf.get(cat.id) ?? []) {
      const pct = visit(child);
      const item = totalItemOf.get(child.id);
      entries.push({ grade: pct, min: 0, max: 100, weight: item?.weight ?? 1 });
    }
    visiting.delete(cat.id);

    const item = totalItemOf.get(cat.id);
    if (item && fixed.has(item.id)) return toPercent(fixed.get(item.id) ?? null, item.gradeMin, item.gradeMax);
    const pct = aggregate(cat.aggregation, entries, cat.dropLowest);
    if (item) out.set(item.id, fromPercent(pct, item.gradeMin, item.gradeMax));
    return pct;
  };
  visit(root);
  return out;
}

// ─── CSV ────────────────────────────────────────────────────────────────────

/** Escapes one CSV cell (RFC 4180) and neutralises spreadsheet formula injection. */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: (string | number | null | undefined)[][]): string {
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/** Formats a grade for display/export (max 2 decimals). */
export function formatGrade(value: number | null): string {
  if (value === null) return "";
  return String(Math.round(value * 100) / 100);
}
