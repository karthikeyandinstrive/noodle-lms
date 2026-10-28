"use client";

import { ArrowDown, ArrowUp, Check, ClipboardCheck, Plus, Trash2, Users } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState, HtmlContent, QueryState } from "@/components/common";
import { RichTextEditor } from "@/components/rich-text-editor";
import { useFormat, useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { ActivityTypeUI, ActivityViewProps, SettingsFieldsProps } from "../activities/types";
import { PHASES, fmt, phaseLabel, useWorkshop, type Criterion, type Phase, type WorkshopOverview } from "./api";
import { ManagerPanel } from "./manager";
import { SubmissionCard, SubmissionForm } from "./submission";

function PhaseStepper({ phase }: { phase: Phase }) {
  const current = PHASES.indexOf(phase);
  const t = useT();
  return (
    <ol className="grid grid-cols-5 gap-1" aria-label={t("workshop.phases", "Workshop phases")}>
      {PHASES.map((p, i) => (
        <li key={p} aria-current={i === current ? "step" : undefined} className="flex flex-col items-center gap-1 text-center">
          <span
            className={cn(
              "flex size-7 items-center justify-center rounded-full border text-xs font-medium",
              i < current && "border-primary bg-primary/10 text-primary",
              i === current && "border-primary bg-primary text-primary-foreground",
              i > current && "text-muted-foreground",
            )}
          >
            {i < current ? <Check className="size-3.5" aria-hidden /> : <span aria-hidden>{i + 1}</span>}
          </span>
          <span className={cn("text-[11px] leading-tight sm:text-xs", i === current ? "font-medium" : "text-muted-foreground")}>
            {phaseLabel(t, p)}
            <span className="sr-only">
              {" "}
              ({i < current ? t("workshop.phaseDone", "completed") : i === current ? t("workshop.phaseCurrent", "current") : t("workshop.phaseUpcoming", "upcoming")})
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}

function WorkshopView({ activity }: ActivityViewProps) {
  const query = useWorkshop(activity.id);
  return (
    <QueryState query={query}>
      {query.data && (
        <div className="space-y-6">
          <PhaseStepper phase={query.data.phase} />
          <LearnerPanel activityId={activity.id} w={query.data} />
          {query.data.canManage && <ManagerPanel activityId={activity.id} w={query.data} />}
        </div>
      )}
    </QueryState>
  );
}

function LearnerPanel({ activityId, w }: { activityId: string; w: WorkshopOverview }) {
  const t = useT();
  const fmtx = useFormat();
  const submissionClosed = !!w.submissionEndAt && new Date(w.submissionEndAt) < new Date();
  const sections: React.ReactNode[] = [];

  if (w.phase === "setup") {
    sections.push(
      <p key="setup" className="text-sm text-muted-foreground">
        {t("workshop.beingSetUp", "The workshop is being set up. You’ll be notified when submissions open.")}
      </p>,
    );
  }

  if (w.phase === "setup" || w.phase === "submission") {
    if (w.instructions) sections.push(<InstructionCard key="instr" title={t("workshop.instructions", "Instructions")} html={w.instructions} />);
  }

  if (w.canSubmit) {
    if (w.phase === "submission" && !submissionClosed) {
      sections.push(<SubmissionForm key="form" activityId={activityId} existing={w.mySubmission} deadline={w.submissionEndAt} />);
    } else if (w.mySubmission) {
      sections.push(<SubmissionCard key="mine" submission={w.mySubmission} />);
    } else if (w.phase !== "setup") {
      sections.push(
        <p key="none" className="text-sm text-muted-foreground">
          {w.phase === "submission"
            ? t("workshop.deadlinePassed", "The submission deadline has passed.")
            : t("workshop.didNotSubmit", "You did not submit work for this workshop.")}
        </p>,
      );
    }
  }

  if (w.phase === "assessment" && w.assessmentInstructions) {
    sections.push(<InstructionCard key="ainstr" title={t("workshop.howToAssess", "How to assess")} html={w.assessmentInstructions} />);
  }

  if (w.myAssessments.length > 0 && w.phase !== "setup" && w.phase !== "submission") {
    sections.push(
      <Card key="todo">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ClipboardCheck className="size-5" aria-hidden /> {t("workshop.assessments", "Assessments")}
          </CardTitle>
          <CardDescription>
            {t("workshop.nOfMDone", "{n} of {total} done", { n: w.myAssessments.filter((a) => a.submittedAt).length, total: w.myAssessments.length })}
            {w.assessmentEndAt && ` · ${t("workshop.dueLower", "due {date}", { date: fmtx.date(w.assessmentEndAt) })}`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="divide-y">
            {w.myAssessments.map((a, i) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{a.isOwn
                      ? t("workshop.selfAssessmentTitle", "Self-assessment: {title}", { title: a.submissionTitle })
                      : t("workshop.submissionNTitle", "Submission {n}: {title}", { n: i + 1, title: a.submissionTitle })}</p>
                  {a.submittedAt ? (
                    <p className="text-xs text-muted-foreground">{t("workshop.submittedGrade", "Submitted · {grade}%", { grade: fmt(a.grade, 1) })}</p>
                  ) : (
                    <p className="text-xs text-muted-foreground">{t("workshop.notAssessedYet", "Not assessed yet")}</p>
                  )}
                </div>
                <Link
                  href={`/activities/${activityId}/workshop/assessments/${a.id}`}
                  className={buttonVariants({ size: "sm", variant: a.submittedAt ? "outline" : "default" })}
                >
                  {w.phase === "assessment" ? (a.submittedAt ? t("workshop.revise", "Revise") : t("workshop.assess", "Assess")) : t("common.view", "View")}
                </Link>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>,
    );
  } else if (w.phase === "assessment" && w.canAssess && !w.canManage) {
    sections.push(<EmptyState
        key="noalloc"
        title={t("workshop.noAllocations", "No submissions allocated to you")}
        description={t("workshop.noAllocationsHint", "Your teacher hasn’t asked you to assess anyone yet.")}
      />);
  }

  if (w.myResults) sections.push(<ResultsCard key="results" w={w} />);

  if (!sections.length) return null;
  return <div className="space-y-4">{sections}</div>;
}

function InstructionCard({ title, html }: { title: string; html: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <HtmlContent html={html} />
      </CardContent>
    </Card>
  );
}

function ResultsCard({ w }: { w: WorkshopOverview }) {
  const r = w.myResults!;
  const t = useT();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("workshop.yourResults", "Your results")}</CardTitle>
        <CardDescription>
          {r.total === null
            ? t("workshop.gradesNotCalculated", "Grades haven’t been calculated yet.")
            : t("workshop.totalOf", "Total {total} / {max}", { total: fmt(r.total), max: w.submissionGradeMax + w.assessmentGradeMax })}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div className="rounded-lg border p-3">
            <dt className="text-muted-foreground">{t("workshop.phase.submission", "Submission")}</dt>
            <dd className="text-lg font-semibold tabular-nums">
              {fmt(r.submissionGrade)} <span className="text-sm font-normal text-muted-foreground">/ {w.submissionGradeMax}</span>
            </dd>
          </div>
          <div className="rounded-lg border p-3">
            <dt className="text-muted-foreground">{t("workshop.assessing", "Assessing")}</dt>
            <dd className="text-lg font-semibold tabular-nums">
              {fmt(r.gradingGrade)} <span className="text-sm font-normal text-muted-foreground">/ {w.assessmentGradeMax}</span>
            </dd>
          </div>
        </dl>
        {r.received.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-sm font-medium">{t("workshop.peerFeedback", "Feedback from your peers")}</h3>
            <ul className="space-y-2">
              {r.received.map((a, i) => (
                <li key={a.id} className="rounded-lg border p-3 text-sm">
                  <div className="flex justify-between gap-2">
                    <span className="font-medium">{t("workshop.reviewerN", "Reviewer {n}", { n: i + 1 })}</span>
                    <Badge variant="secondary">{fmt(a.grade, 1)}%</Badge>
                  </div>
                  {a.scores && (
                    <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
                      {w.criteria.map((c) => (
                        <li key={c.id}>
                          {c.description}: {a.scores?.[c.id] ?? "—"} / {c.maxScore}
                        </li>
                      ))}
                    </ul>
                  )}
                  <HtmlContent html={a.feedback} className="mt-2" />
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Settings ───────────────────────────────────────────────────────────────

const toLocalInput = (iso: unknown) => {
  if (!iso || typeof iso !== "string") return "";
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : null);
const newId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `c${Date.now()}${Math.random().toString(36).slice(2, 8)}`);

function WorkshopSettings({ value, onChange }: SettingsFieldsProps) {
  const set = (k: string, v: unknown) => onChange({ ...value, [k]: v });
  const criteria = (value.criteria as Criterion[] | undefined) ?? [];
  const setCriteria = (next: Criterion[]) => set("criteria", next);
  const t = useT();
  const num = (k: string, fallback: number) => (value[k] === undefined || value[k] === null ? fallback : Number(value[k]));

  const move = (i: number, d: -1 | 1) => {
    const next = [...criteria];
    const j = i + d;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j]!, next[i]!];
    setCriteria(next);
  };

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <Label htmlFor="ws-instr">{t("workshop.instructionsForSubmission", "Instructions for submission")}</Label>
        <RichTextEditor id="ws-instr" value={(value.instructions as string | null) ?? ""} onChange={(html) => set("instructions", html || null)} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="ws-ainstr">{t("workshop.instructionsForAssessment", "Instructions for assessment")}</Label>
        <RichTextEditor
          id="ws-ainstr"
          minHeight={100}
          value={(value.assessmentInstructions as string | null) ?? ""}
          onChange={(html) => set("assessmentInstructions", html || null)}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="ws-subend">{t("workshop.submissionsClose", "Submissions close")}</Label>
          <Input id="ws-subend" type="datetime-local" value={toLocalInput(value.submissionEndAt)} onChange={(e) => set("submissionEndAt", fromLocalInput(e.target.value))} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ws-assend">{t("workshop.assessmentsClose", "Assessments close")}</Label>
          <Input id="ws-assend" type="datetime-local" value={toLocalInput(value.assessmentEndAt)} onChange={(e) => set("assessmentEndAt", fromLocalInput(e.target.value))} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ws-sgm">{t("workshop.maxGradeSubmission", "Maximum grade for submission")}</Label>
          <Input id="ws-sgm" type="number" min={0} max={1000} step="any" value={String(num("submissionGradeMax", 80))} onChange={(e) => set("submissionGradeMax", Number(e.target.value) || 0)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ws-agm">{t("workshop.maxGradeAssessing", "Maximum grade for assessing")}</Label>
          <Input id="ws-agm" type="number" min={0} max={1000} step="any" value={String(num("assessmentGradeMax", 20))} onChange={(e) => set("assessmentGradeMax", Number(e.target.value) || 0)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ws-rps">{t("workshop.reviewsPerSubmission", "Reviews per submission")}</Label>
          <Input id="ws-rps" type="number" min={0} max={20} value={String(num("reviewsPerSubmission", 3))} onChange={(e) => set("reviewsPerSubmission", Math.max(0, Math.min(20, Math.round(Number(e.target.value) || 0))))} />
        </div>
        <div className="flex items-center gap-2 pt-6">
          <Switch id="ws-self" checked={!!value.allowSelfAssessment} onCheckedChange={(v) => set("allowSelfAssessment", v)} />
          <Label htmlFor="ws-self" className="font-normal">
            {t("workshop.allowSelfAssessment", "Allow self-assessment")}
          </Label>
        </div>
      </div>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">{t("workshop.rubric", "Assessment rubric")}</legend>
        <p className="text-xs text-muted-foreground">
          {t("workshop.rubricHint", "Reviewers score each criterion from 0 to its maximum; weights set its share of the grade.")}
        </p>
        {criteria.length === 0 && (
          <p className="text-sm text-muted-foreground">{t("workshop.noCriteriaYet", "No criteria yet — add at least one before the assessment phase.")}</p>
        )}
        <ol className="space-y-3">
          {criteria.map((c, i) => (
            <li key={c.id} className="space-y-2 rounded-lg border p-3">
              <div className="flex items-start gap-2">
                <span className="pt-1.5 text-sm font-medium text-muted-foreground" aria-hidden>
                  {i + 1}.
                </span>
                <div className="min-w-0 flex-1 space-y-1">
                  <Label htmlFor={`c-desc-${c.id}`} className="sr-only">
                    {t("workshop.criterionDescription", "Criterion {n} description", { n: i + 1 })}
                  </Label>
                  <Textarea
                    id={`c-desc-${c.id}`}
                    rows={2}
                    placeholder={t("workshop.criterionPlaceholder", "What should reviewers look for?")}
                    value={c.description}
                    onChange={(e) => setCriteria(criteria.map((x) => (x.id === c.id ? { ...x, description: e.target.value } : x)))}
                  />
                </div>
                <div className="flex flex-col gap-0.5">
                  <Button type="button" size="icon-xs" variant="ghost" aria-label={t("workshop.moveCriterionUp", "Move criterion {n} up", { n: i + 1 })} disabled={i === 0} onClick={() => move(i, -1)}>
                    <ArrowUp aria-hidden />
                  </Button>
                  <Button type="button" size="icon-xs" variant="ghost" aria-label={t("workshop.moveCriterionDown", "Move criterion {n} down", { n: i + 1 })} disabled={i === criteria.length - 1} onClick={() => move(i, 1)}>
                    <ArrowDown aria-hidden />
                  </Button>
                </div>
              </div>
              <div className="flex flex-wrap items-end gap-3 pl-5">
                <div className="space-y-1">
                  <Label htmlFor={`c-max-${c.id}`} className="text-xs">
                    {t("workshop.maxScore", "Max score")}
                  </Label>
                  <Input
                    id={`c-max-${c.id}`}
                    type="number"
                    min={1}
                    max={1000}
                    className="h-8 w-24"
                    value={String(c.maxScore)}
                    onChange={(e) => setCriteria(criteria.map((x) => (x.id === c.id ? { ...x, maxScore: Number(e.target.value) || 0 } : x)))}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`c-w-${c.id}`} className="text-xs">
                    {t("workshop.weight", "Weight")}
                  </Label>
                  <Input
                    id={`c-w-${c.id}`}
                    type="number"
                    min={0}
                    max={100}
                    step="any"
                    className="h-8 w-24"
                    value={String(c.weight)}
                    onChange={(e) => setCriteria(criteria.map((x) => (x.id === c.id ? { ...x, weight: Number(e.target.value) || 0 } : x)))}
                  />
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="text-destructive"
                  onClick={() => setCriteria(criteria.filter((x) => x.id !== c.id))}
                  aria-label={t("workshop.removeCriterion", "Remove criterion {n}", { n: i + 1 })}
                >
                  <Trash2 aria-hidden /> {t("common.remove", "Remove")}
                </Button>
              </div>
            </li>
          ))}
        </ol>
        <Button type="button" variant="outline" size="sm" onClick={() => setCriteria([...criteria, { id: newId(), description: "", maxScore: 10, weight: 1 }])}>
          <Plus aria-hidden /> {t("workshop.addCriterion", "Add criterion")}
        </Button>
      </fieldset>
    </div>
  );
}

export const workshopActivity: ActivityTypeUI = {
  type: "workshop",
  label: "Workshop",
  description: "Peer assessment",
  icon: Users,
  defaults: {
    instructions: null,
    assessmentInstructions: null,
    submissionGradeMax: 80,
    assessmentGradeMax: 20,
    reviewsPerSubmission: 3,
    allowSelfAssessment: false,
    criteria: [],
  },
  defaultCompletion: "submit",
  View: WorkshopView,
  SettingsFields: WorkshopSettings,
};
