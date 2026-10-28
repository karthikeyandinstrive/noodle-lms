/**
 * Pure workshop logic (no DB): rubric normalization, reviewer allocation and
 * evaluation grades. Unit-tested in logic.test.ts.
 */

export type Criterion = { id: string; description: string; maxScore: number; weight: number };

const round = (n: number, dp = 5) => Math.round(n * 10 ** dp) / 10 ** dp;

/**
 * Normalized 0–100 grade of one assessment: weighted mean of score/maxScore.
 * Every criterion must be scored within 0..maxScore.
 */
export function assessmentGrade(criteria: Criterion[], scores: Record<string, number>): number {
  if (!criteria.length) throw new Error("The workshop has no assessment criteria");
  let weighted = 0;
  let weights = 0;
  for (const c of criteria) {
    const s = scores[c.id];
    if (s === undefined || !Number.isFinite(s)) throw new Error(`Missing score for "${c.description}"`);
    if (s < 0 || s > c.maxScore) throw new Error(`Score for "${c.description}" must be between 0 and ${c.maxScore}`);
    weighted += c.weight * (c.maxScore > 0 ? s / c.maxScore : 0);
    weights += c.weight;
  }
  return weights > 0 ? round((weighted / weights) * 100) : 0;
}

export type AllocationSubmission = { id: string; authorId: string };
export type Allocation = { submissionId: string; reviewerId: string };

/**
 * Random, load-balanced reviewer allocation.
 *
 * Each submission receives up to `perSubmission` reviewers in total (existing
 * allocations count). Authors never review their own work unless
 * `allowSelf`. Reviewers are chosen least-loaded first, ties broken randomly,
 * so loads differ by at most one whenever the constraints allow it.
 * Returns only the NEW allocations.
 */
export function allocateReviewers(input: {
  submissions: AllocationSubmission[];
  reviewers: string[];
  perSubmission: number;
  allowSelf: boolean;
  existing?: Allocation[];
  random?: () => number;
}): Allocation[] {
  const rand = input.random ?? Math.random;
  const reviewers = [...new Set(input.reviewers)];
  const load = new Map<string, number>(reviewers.map((r) => [r, 0]));
  const assigned = new Map<string, Set<string>>(input.submissions.map((s) => [s.id, new Set()]));
  for (const a of input.existing ?? []) {
    assigned.get(a.submissionId)?.add(a.reviewerId);
    if (load.has(a.reviewerId)) load.set(a.reviewerId, load.get(a.reviewerId)! + 1);
  }

  const shuffle = <T>(arr: T[]) => {
    const out = [...arr];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  };

  const result: Allocation[] = [];
  // Round-robin over submissions so that early submissions don't exhaust the least-loaded reviewers.
  const order = shuffle(input.submissions);
  for (let round = 0; round < input.perSubmission; round++) {
    for (const sub of order) {
      const have = assigned.get(sub.id)!;
      if (have.size >= input.perSubmission) continue;
      const candidates = reviewers.filter((r) => !have.has(r) && (input.allowSelf || r !== sub.authorId));
      if (!candidates.length) continue;
      const minLoad = Math.min(...candidates.map((r) => load.get(r)!));
      const best = candidates.filter((r) => load.get(r) === minLoad);
      const pick = best[Math.floor(rand() * best.length)]!;
      have.add(pick);
      load.set(pick, minLoad + 1);
      result.push({ submissionId: sub.id, reviewerId: pick });
    }
  }

  // Repair pass: greedy choices late in a round can leave loads differing by 2+.
  // Move new allocations from the most- to a least-loaded eligible reviewer until balanced.
  const authorOf = new Map(input.submissions.map((s) => [s.id, s.authorId]));
  for (let guard = 0; guard < result.length * reviewers.length + 1; guard++) {
    let moved = false;
    const loads = [...load.values()];
    const max = Math.max(...loads);
    for (const a of shuffle(result)) {
      if (load.get(a.reviewerId) !== max) continue;
      const have = assigned.get(a.submissionId)!;
      const target = shuffle(reviewers).find(
        (r) => load.get(r)! <= max - 2 && !have.has(r) && (input.allowSelf || r !== authorOf.get(a.submissionId)),
      );
      if (!target) continue;
      have.delete(a.reviewerId);
      have.add(target);
      load.set(a.reviewerId, max - 1);
      load.set(target, load.get(target)! + 1);
      a.reviewerId = target;
      moved = true;
      break;
    }
    if (!moved) break;
  }
  return result;
}

export type EvalAssessment = { id: string; submissionId: string; reviewerId: string; grade: number | null };

/**
 * Evaluation:
 *  - submission grade (0–100) = weighted mean of its submitted assessment grades
 *    (weight 1 each unless given), scaled to `submissionGradeMax`;
 *  - each assessment's quality = 100 − |its grade − that submission's mean|;
 *  - a reviewer's grading grade = mean quality of their assessments
 *    (= 100 − mean absolute deviation), scaled to `assessmentGradeMax`.
 * Submissions without assessments get no grade.
 */
export function computeWorkshopGrades(input: {
  assessments: EvalAssessment[];
  submissionGradeMax: number;
  assessmentGradeMax: number;
  weights?: Record<string, number>;
}) {
  const bySubmission = new Map<string, EvalAssessment[]>();
  for (const a of input.assessments) {
    if (a.grade === null) continue;
    const list = bySubmission.get(a.submissionId) ?? [];
    list.push(a);
    bySubmission.set(a.submissionId, list);
  }

  const submissionMean = new Map<string, number>();
  const submissionGrades = new Map<string, number>();
  for (const [id, list] of bySubmission) {
    let sum = 0;
    let w = 0;
    for (const a of list) {
      const weight = input.weights?.[a.id] ?? 1;
      sum += a.grade! * weight;
      w += weight;
    }
    if (w <= 0) continue;
    const mean = sum / w;
    submissionMean.set(id, mean);
    submissionGrades.set(id, round((mean / 100) * input.submissionGradeMax));
  }

  const assessmentQuality = new Map<string, number>();
  const perReviewer = new Map<string, number[]>();
  for (const list of bySubmission.values()) {
    const mean = submissionMean.get(list[0]!.submissionId);
    if (mean === undefined) continue;
    for (const a of list) {
      const q = Math.max(0, 100 - Math.abs(a.grade! - mean));
      assessmentQuality.set(a.id, round(q));
      perReviewer.set(a.reviewerId, [...(perReviewer.get(a.reviewerId) ?? []), q]);
    }
  }
  const reviewerGrades = new Map<string, number>();
  for (const [reviewer, qs] of perReviewer) {
    const mean = qs.reduce((x, y) => x + y, 0) / qs.length;
    reviewerGrades.set(reviewer, round((mean / 100) * input.assessmentGradeMax));
  }
  return { submissionGrades, assessmentQuality, reviewerGrades };
}

/** Final activity grade of a participant: (override ?? computed submission grade) + grading grade. */
export function totalGrade(parts: { submission: number | null; override: number | null; grading: number | null }) {
  const sub = parts.override ?? parts.submission;
  if (sub === null && parts.grading === null) return null;
  return round((sub ?? 0) + (parts.grading ?? 0));
}
