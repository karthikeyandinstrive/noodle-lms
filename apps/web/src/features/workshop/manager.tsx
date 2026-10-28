"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Calculator, Eye, Plus, Shuffle, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState, HtmlContent, QueryState, fullName } from "@/components/common";
import { api, errorMessage } from "@/lib/api";
import { FileList } from "./submission";
import {
  PHASE_LABELS,
  PHASES,
  fmt,
  useAllocations,
  useSubmissionDetail,
  useWorkshopGrades,
  workshopKeys,
  type Phase,
  type WorkshopOverview,
} from "./api";

const selectClass = "h-8 rounded-lg border bg-background px-2 text-sm";

export function ManagerPanel({ activityId, w }: { activityId: string; w: WorkshopOverview }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Manage workshop</CardTitle>
        {w.stats && (
          <CardDescription>
            {w.stats.submissions} of {w.stats.participants} submitted · {w.stats.assessed} of {w.stats.allocations} assessments done
          </CardDescription>
        )}
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="phase">
          <TabsList className="w-full sm:w-fit">
            <TabsTrigger value="phase">Phase</TabsTrigger>
            <TabsTrigger value="allocation">Allocation</TabsTrigger>
            <TabsTrigger value="grades">Grades</TabsTrigger>
          </TabsList>
          <TabsContent value="phase" className="pt-3">
            <PhaseControl activityId={activityId} phase={w.phase} />
          </TabsContent>
          <TabsContent value="allocation" className="pt-3">
            <AllocationPanel activityId={activityId} w={w} />
          </TabsContent>
          <TabsContent value="grades" className="pt-3">
            <GradesPanel activityId={activityId} w={w} />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

function PhaseControl({ activityId, phase }: { activityId: string; phase: Phase }) {
  const qc = useQueryClient();
  const [target, setTarget] = useState<Phase | null>(null);
  const next = PHASES[PHASES.indexOf(phase) + 1];
  const change = useMutation({
    mutationFn: (p: Phase) => api(`/workshops/${activityId}/phase`, { method: "PUT", body: { phase: p } }),
    onSuccess: async () => {
      setTarget(null);
      toast.success("Phase switched; participants were notified");
      await qc.invalidateQueries({ queryKey: workshopKeys.all(activityId) });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <div className="space-y-3">
      <p className="text-sm">
        Current phase: <strong>{PHASE_LABELS[phase]}</strong>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {next && <Button onClick={() => setTarget(next)}>Switch to {PHASE_LABELS[next].toLowerCase()} phase</Button>}
        <Label htmlFor="ws-phase" className="sr-only">
          Switch to phase
        </Label>
        <select
          id="ws-phase"
          className={selectClass}
          value=""
          onChange={(e) => e.target.value && setTarget(e.target.value as Phase)}
        >
          <option value="">Other phase…</option>
          {PHASES.filter((p) => p !== phase).map((p) => (
            <option key={p} value={p}>
              {PHASE_LABELS[p]}
            </option>
          ))}
        </select>
      </div>
      <AlertDialog open={!!target} onOpenChange={(o) => !o && setTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Switch to the {target ? PHASE_LABELS[target].toLowerCase() : ""} phase?</AlertDialogTitle>
            <AlertDialogDescription>All participants will be notified of the change.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button disabled={change.isPending} onClick={() => target && change.mutate(target)}>
              {change.isPending ? "Switching…" : "Switch phase"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function AllocationPanel({ activityId, w }: { activityId: string; w: WorkshopOverview }) {
  const qc = useQueryClient();
  const query = useAllocations(activityId);
  const [replace, setReplace] = useState(false);
  const [includeNon, setIncludeNon] = useState(false);
  const [adding, setAdding] = useState<Record<string, string>>({});
  const canAllocate = ["setup", "submission", "assessment"].includes(w.phase);
  const refresh = () => qc.invalidateQueries({ queryKey: workshopKeys.all(activityId) });

  const random = useMutation({
    mutationFn: () => api<{ created: number; removed: number }>(`/workshops/${activityId}/allocations/random`, { body: { replace, includeNonSubmitters: includeNon } }),
    onSuccess: async (r) => {
      toast.success(`${r.created} allocation${r.created === 1 ? "" : "s"} added${r.removed ? `, ${r.removed} removed` : ""}`);
      await refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const add = useMutation({
    mutationFn: (v: { submissionId: string; reviewerId: string }) => api(`/workshops/${activityId}/allocations`, { body: v }),
    onSuccess: async (_r, v) => {
      setAdding((a) => ({ ...a, [v.submissionId]: "" }));
      await refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (assessmentId: string) => api(`/workshops/${activityId}/allocations/${assessmentId}`, { method: "DELETE" }),
    onSuccess: refresh,
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <QueryState query={query}>
      {query.data && (
        <div className="space-y-4">
          {canAllocate ? (
            <div className="space-y-2 rounded-lg border p-3">
              <p className="text-sm">
                Randomly allocate {w.reviewsPerSubmission} reviewer{w.reviewsPerSubmission === 1 ? "" : "s"} per submission
                {w.allowSelfAssessment ? " (self-assessment allowed)" : ""}.
              </p>
              <div className="flex flex-col gap-2 text-sm sm:flex-row sm:gap-4">
                <label className="flex items-center gap-2">
                  <Checkbox checked={replace} onCheckedChange={(v) => setReplace(!!v)} /> Remove unassessed allocations first
                </label>
                <label className="flex items-center gap-2">
                  <Checkbox checked={includeNon} onCheckedChange={(v) => setIncludeNon(!!v)} /> Learners without a submission can review
                </label>
              </div>
              <Button size="sm" disabled={random.isPending || !query.data.submissions.length} onClick={() => random.mutate()}>
                <Shuffle /> {random.isPending ? "Allocating…" : "Allocate randomly"}
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Allocations can only change during the setup, submission and assessment phases.</p>
          )}

          {query.data.submissions.length === 0 ? (
            <EmptyState title="No submissions yet" />
          ) : (
            <ul className="divide-y rounded-lg border">
              {query.data.submissions.map((s) => {
                const taken = new Set(s.reviewers.map((r) => r.reviewer.id));
                const options = query.data.participants.filter((p) => !taken.has(p.id) && (w.allowSelfAssessment || p.id !== s.author.id));
                return (
                  <li key={s.id} className="space-y-2 p-3">
                    <div>
                      <p className="font-medium break-words">{s.title}</p>
                      <p className="text-xs text-muted-foreground">by {fullName(s.author)}</p>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {s.reviewers.length === 0 && <span className="text-xs text-muted-foreground">No reviewers</span>}
                      {s.reviewers.map((r) => (
                        <Badge key={r.assessmentId} variant={r.submittedAt ? "secondary" : "outline"} className="h-6 gap-1 pr-1">
                          {fullName(r.reviewer)}
                          {r.submittedAt && <span className="text-muted-foreground">· {fmt(r.grade, 0)}%</span>}
                          {canAllocate && (
                            <button
                              type="button"
                              className="rounded-full p-0.5 hover:bg-muted"
                              aria-label={`Remove ${fullName(r.reviewer)} as reviewer`}
                              onClick={() => {
                                if (!r.submittedAt || window.confirm("This reviewer already submitted an assessment. Remove it?")) remove.mutate(r.assessmentId);
                              }}
                            >
                              <X className="size-3" />
                            </button>
                          )}
                        </Badge>
                      ))}
                    </div>
                    {canAllocate && options.length > 0 && (
                      <div className="flex flex-wrap items-center gap-2">
                        <Label htmlFor={`add-${s.id}`} className="sr-only">
                          Add reviewer for {s.title}
                        </Label>
                        <select
                          id={`add-${s.id}`}
                          className={`${selectClass} min-w-0 flex-1 sm:flex-none`}
                          value={adding[s.id] ?? ""}
                          onChange={(e) => setAdding((a) => ({ ...a, [s.id]: e.target.value }))}
                        >
                          <option value="">Add reviewer…</option>
                          {options.map((p) => (
                            <option key={p.id} value={p.id}>
                              {fullName(p)} ({p.reviewing} assigned)
                            </option>
                          ))}
                        </select>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!adding[s.id] || add.isPending}
                          onClick={() => add.mutate({ submissionId: s.id, reviewerId: adding[s.id]! })}
                        >
                          <Plus /> Add
                        </Button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </QueryState>
  );
}

function GradesPanel({ activityId, w }: { activityId: string; w: WorkshopOverview }) {
  const qc = useQueryClient();
  const query = useWorkshopGrades(activityId);
  const [viewing, setViewing] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const canEvaluate = w.phase === "evaluation" || w.phase === "closed";

  const evaluate = useMutation({
    mutationFn: () => api<{ graded: number }>(`/workshops/${activityId}/evaluate`, { body: {} }),
    onSuccess: async (r) => {
      toast.success(`Grades calculated and sent to the gradebook for ${r.graded} participant${r.graded === 1 ? "" : "s"}`);
      await qc.invalidateQueries({ queryKey: workshopKeys.all(activityId) });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const override = useMutation({
    mutationFn: (v: { submissionId: string; gradeOverride: number | null }) =>
      api(`/workshops/${activityId}/submissions/${v.submissionId}/override`, { method: "PUT", body: { gradeOverride: v.gradeOverride } }),
    onSuccess: async (_r, v) => {
      toast.success(v.gradeOverride === null ? "Override cleared" : "Grade overridden");
      setOverrides((o) => ({ ...o, [v.submissionId]: "" }));
      await qc.invalidateQueries({ queryKey: workshopKeys.all(activityId) });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <QueryState query={query}>
      {query.data && (
        <div className="space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground">
              Submission grade out of {w.submissionGradeMax} + assessment grade out of {w.assessmentGradeMax}.
            </p>
            <Button size="sm" disabled={!canEvaluate || evaluate.isPending} onClick={() => evaluate.mutate()} title={canEvaluate ? undefined : "Switch to the evaluation phase first"}>
              <Calculator /> {evaluate.isPending ? "Calculating…" : "Calculate & push grades"}
            </Button>
          </div>
          {query.data.length === 0 ? (
            <EmptyState title="Nothing to grade yet" />
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Participant</TableHead>
                    <TableHead>Submission</TableHead>
                    <TableHead className="text-right">Grade</TableHead>
                    <TableHead>Override</TableHead>
                    <TableHead className="text-right">Assessing</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {query.data.map((r) => (
                    <TableRow key={r.user.id}>
                      <TableCell className="font-medium whitespace-nowrap">{fullName(r.user)}</TableCell>
                      <TableCell className="max-w-48">
                        {r.submissionId ? (
                          <Button variant="link" size="sm" className="h-auto max-w-full truncate p-0" onClick={() => setViewing(r.submissionId)}>
                            <Eye /> <span className="truncate">{r.submissionTitle}</span>
                          </Button>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{fmt(r.submissionGrade)}</TableCell>
                      <TableCell>
                        {r.submissionId && (
                          <form
                            className="flex items-center gap-1"
                            onSubmit={(e) => {
                              e.preventDefault();
                              const raw = overrides[r.submissionId!] ?? "";
                              override.mutate({ submissionId: r.submissionId!, gradeOverride: raw === "" ? null : Number(raw) });
                            }}
                          >
                            <Input
                              type="number"
                              min={0}
                              max={w.submissionGradeMax}
                              step="any"
                              className="h-7 w-20"
                              aria-label={`Override grade for ${fullName(r.user)}`}
                              placeholder={r.gradeOverride !== null ? fmt(r.gradeOverride) : "—"}
                              value={overrides[r.submissionId] ?? ""}
                              onChange={(e) => setOverrides((o) => ({ ...o, [r.submissionId!]: e.target.value }))}
                            />
                            <Button type="submit" size="xs" variant="outline" disabled={override.isPending || (overrides[r.submissionId] ?? "") === ""}>
                              Set
                            </Button>
                            {r.gradeOverride !== null && (
                              <Button
                                type="button"
                                size="icon-xs"
                                variant="ghost"
                                aria-label={`Clear override for ${fullName(r.user)}`}
                                onClick={() => override.mutate({ submissionId: r.submissionId!, gradeOverride: null })}
                              >
                                <X />
                              </Button>
                            )}
                          </form>
                        )}
                      </TableCell>
                      <TableCell className="text-right whitespace-nowrap tabular-nums">
                        {fmt(r.gradingGrade)}
                        <span className="block text-xs text-muted-foreground">
                          {r.assessmentsDone}/{r.assessmentsGiven} done
                        </span>
                      </TableCell>
                      <TableCell className="text-right font-medium tabular-nums">{fmt(r.total)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <SubmissionDialog activityId={activityId} submissionId={viewing} criteria={w.criteria} onClose={() => setViewing(null)} />
        </div>
      )}
    </QueryState>
  );
}

function SubmissionDialog({
  activityId,
  submissionId,
  criteria,
  onClose,
}: {
  activityId: string;
  submissionId: string | null;
  criteria: WorkshopOverview["criteria"];
  onClose: () => void;
}) {
  const query = useSubmissionDetail(activityId, submissionId);
  return (
    <Dialog open={!!submissionId} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <QueryState query={query}>
          {query.data && (
            <div className="space-y-4">
              <DialogHeader>
                <DialogTitle className="break-words">{query.data.title}</DialogTitle>
                <p className="text-sm text-muted-foreground">by {fullName(query.data.author)}</p>
              </DialogHeader>
              <HtmlContent html={query.data.content} className="break-words" />
              <FileList files={query.data.files} />
              <h3 className="font-medium">Assessments</h3>
              {query.data.assessments.length === 0 && <p className="text-sm text-muted-foreground">No reviewers allocated.</p>}
              <ul className="space-y-3">
                {query.data.assessments.map((a) => (
                  <li key={a.id} className="rounded-lg border p-3 text-sm">
                    <div className="flex flex-wrap justify-between gap-2">
                      <span className="font-medium">{fullName(a.reviewer)}</span>
                      <span className="text-muted-foreground">
                        {a.submittedAt ? `${fmt(a.grade)}%` : "Not submitted"}
                        {a.gradingGrade !== null && ` · quality ${fmt(a.gradingGrade)}%`}
                      </span>
                    </div>
                    {a.scores && (
                      <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
                        {criteria.map((c) => (
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
        </QueryState>
      </DialogContent>
    </Dialog>
  );
}
