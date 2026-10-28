"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, EyeOff, History, Lock, Search, Settings2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState, QueryState, formatDate, fullName } from "@/components/common";
import { api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import { fmtGrade, gradesKey, type Grade, type GradeHistoryEntry, type GradeItem, type GraderReport, type GradebookUser } from "./types";

type Cell = { item: GradeItem; user: GradebookUser; grade: Grade | undefined };

const SOURCE_LABELS: Record<string, string> = {
  override: "Teacher override",
  override_released: "Override released",
  aggregation: "Recalculated",
};

function useSaveGrade(courseId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { itemId: string; userId: string; finalGrade: number | null; feedback?: string | null; overridden?: boolean }) =>
      api<{ grade: Grade; courseTotal: number | null }>(`/grades/items/${v.itemId}/users/${v.userId}`, {
        method: "PUT",
        body: { finalGrade: v.finalGrade, feedback: v.feedback, overridden: v.overridden ?? true },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: gradesKey(courseId) }),
    onError: (e) => toast.error(errorMessage(e)),
  });
}

/** Parses a typed grade; "" clears it. Returns undefined when invalid. */
function parseGrade(text: string, item: GradeItem): number | null | undefined {
  const t = text.trim().replace(",", ".");
  if (t === "") return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < item.gradeMin || n > item.gradeMax) return undefined;
  return n;
}

/** One grade cell: a button showing the grade; editing happens inline (Enter saves, Escape cancels). */
function GradeCell({ cell, canEdit, courseId, onDetails }: { cell: Cell; canEdit: boolean; courseId: string; onDetails: (c: Cell) => void }) {
  const { item, user, grade } = cell;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const save = useSaveGrade(courseId);
  const value = grade?.finalGrade ?? null;
  const label = `${item.name} for ${fullName(user)}`;
  const editable = canEdit && !item.locked;

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = () => {
    const parsed = parseGrade(text, item);
    if (parsed === undefined) {
      toast.error(`Enter a grade between ${fmtGrade(item.gradeMin)} and ${fmtGrade(item.gradeMax)}`);
      return;
    }
    setEditing(false);
    if (parsed === value) return;
    save.mutate({ itemId: item.id, userId: user.id, finalGrade: parsed });
  };

  if (editing) {
    return (
      <div className="flex items-center gap-1">
        <Input
          ref={inputRef}
          inputMode="decimal"
          className="h-7 w-20 text-right"
          aria-label={`Grade: ${label} (max ${fmtGrade(item.gradeMax)})`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setEditing(false);
            }
          }}
          onBlur={(e) => {
            // Keep editing when focus moves to the details button of this cell.
            if (e.relatedTarget instanceof HTMLElement && e.relatedTarget.dataset.cellDetails === `${item.id}:${user.id}`) return;
            commit();
          }}
        />
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Feedback and history: ${label}`}
          data-cell-details={`${item.id}:${user.id}`}
          onClick={() => {
            setEditing(false);
            onDetails(cell);
          }}
        >
          <History />
        </Button>
      </div>
    );
  }

  const content = (
    <span className={cn("tabular-nums", grade?.overridden && "font-semibold text-amber-700 dark:text-amber-400")}>
      {fmtGrade(value)}
      {grade?.overridden && <span className="sr-only"> (overridden)</span>}
    </span>
  );
  if (!editable) {
    return (
      <button type="button" className="w-full rounded px-1 text-right hover:bg-muted" aria-label={`${label}: ${fmtGrade(value)}. Show history`} onClick={() => onDetails(cell)}>
        {content}
      </button>
    );
  }
  return (
    <button
      type="button"
      className="w-full rounded px-1 text-right hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
      title={grade?.overridden ? "Overridden by a teacher" : "Click to edit"}
      aria-label={`Edit ${label}: ${fmtGrade(value)}`}
      onClick={() => {
        setText(value === null ? "" : String(value));
        setEditing(true);
      }}
    >
      {content}
    </button>
  );
}

function GradeDetailsDialog(props: { cell: Cell | null; canEdit: boolean; courseId: string; onClose: () => void }) {
  if (!props.cell) return null;
  // Keyed so the form state is initialised from the selected cell.
  return <GradeDetailsContent key={`${props.cell.item.id}:${props.cell.user.id}`} {...props} cell={props.cell} />;
}

function GradeDetailsContent({ cell, canEdit, courseId, onClose }: { cell: Cell; canEdit: boolean; courseId: string; onClose: () => void }) {
  const save = useSaveGrade(courseId);
  const [text, setText] = useState(cell.grade?.finalGrade == null ? "" : String(cell.grade.finalGrade));
  const [feedback, setFeedback] = useState(cell.grade?.feedback?.replace(/<[^>]+>/g, "") ?? "");
  const history = useQuery({
    queryKey: [...gradesKey(courseId), "history", cell.item.id, cell.user.id],
    queryFn: () => api<GradeHistoryEntry[]>(`/grades/items/${cell.item.id}/users/${cell.user.id}/history`),
  });
  const { item, user, grade } = cell;
  const editable = canEdit && !item.locked;

  const submit = (overridden: boolean) => {
    const parsed = parseGrade(text, item);
    if (overridden && parsed === undefined) {
      toast.error(`Enter a grade between ${fmtGrade(item.gradeMin)} and ${fmtGrade(item.gradeMax)}`);
      return;
    }
    save.mutate(
      { itemId: item.id, userId: user.id, finalGrade: overridden ? (parsed ?? null) : null, feedback: feedback.trim() || null, overridden },
      {
        onSuccess: () => {
          toast.success(overridden ? "Grade saved" : "Override released");
          onClose();
        },
      },
    );
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{item.name}</DialogTitle>
          <DialogDescription>
            {fullName(user)} · range {fmtGrade(item.gradeMin)}–{fmtGrade(item.gradeMax)}
            {grade?.rawGrade != null && ` · activity grade ${fmtGrade(grade.rawGrade)}`}
          </DialogDescription>
        </DialogHeader>
        {editable ? (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              submit(true);
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="grade-value">Grade</Label>
              <Input id="grade-value" inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="grade-feedback">Feedback</Label>
              <Textarea id="grade-feedback" rows={3} value={feedback} onChange={(e) => setFeedback(e.target.value)} />
            </div>
            <DialogFooter>
              {grade?.overridden && (
                <Button type="button" variant="outline" disabled={save.isPending} onClick={() => submit(false)}>
                  Release override
                </Button>
              )}
              <Button type="submit" disabled={save.isPending}>
                Save override
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <p className="text-sm text-muted-foreground">{item.locked ? "This grade item is locked." : "You can view this grade but not change it."}</p>
        )}
        <section aria-labelledby="grade-history-title">
          <h3 id="grade-history-title" className="mb-2 text-sm font-medium">
            History
          </h3>
          <QueryState query={history}>
            {history.data?.length ? (
              <ol className="max-h-48 space-y-1 overflow-y-auto text-sm">
                {history.data.map((h) => (
                  <li key={h.id} className="flex flex-wrap justify-between gap-2 border-b py-1 last:border-0">
                    <span>
                      {fmtGrade(h.oldGrade)} → <strong>{fmtGrade(h.newGrade)}</strong>{" "}
                      <span className="text-muted-foreground">({SOURCE_LABELS[h.source] ?? h.source})</span>
                    </span>
                    <span className="text-muted-foreground">
                      {formatDate(h.changedAt)}
                      {h.changedBy && ` · ${fullName(h.changedBy)}`}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-muted-foreground">No changes recorded.</p>
            )}
          </QueryState>
        </section>
      </DialogContent>
    </Dialog>
  );
}

export function GraderReportView({ courseId, canSetup }: { courseId: string; canSetup: boolean }) {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [details, setDetails] = useState<Cell | null>(null);
  const query = useQuery({
    queryKey: [...gradesKey(courseId), "grader", { page, search }],
    queryFn: () => api<GraderReport>(`/grades/courses/${courseId}`, { query: { page, pageSize: 25, search } }),
    placeholderData: keepPreviousData,
  });
  const data = query.data;
  const pages = data ? Math.max(1, Math.ceil(data.users.total / data.users.pageSize)) : 1;
  const gradeOf = new Map((data?.grades ?? []).map((g) => [`${g.itemId}:${g.userId}`, g]));

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full max-w-sm">
          <Search className="absolute top-2 left-2.5 size-4 text-muted-foreground" aria-hidden />
          <Input
            className="pl-8"
            placeholder="Search learners"
            aria-label="Search learners"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          {canSetup && (
            <Button variant="outline" size="sm" render={<Link href={`/courses/${courseId}/grades/setup`} />}>
              <Settings2 /> Gradebook setup
            </Button>
          )}
          {data?.capabilities.export && (
            <Button variant="outline" size="sm" render={<a href={`/api/v1/grades/courses/${courseId}/export.csv`} download />}>
              <Download /> Export CSV
            </Button>
          )}
        </div>
      </div>
      <QueryState query={query}>
        {data && (data.users.total === 0 && !search ? (
          <EmptyState title="No learners yet" description="Grades appear here once students are enrolled." />
        ) : (
          <>
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full border-collapse text-sm">
                <caption className="sr-only">Grader report for {data.course.fullname}: learners in rows, grade items in columns</caption>
                <thead className="bg-muted/50">
                  <tr>
                    <th scope="col" className="sticky left-0 z-10 min-w-40 bg-muted px-3 py-2 text-left font-medium">
                      Learner
                    </th>
                    {data.items.map((item) => (
                      <th
                        key={item.id}
                        scope="col"
                        className={cn("min-w-24 px-2 py-2 text-right align-bottom font-medium", item.type !== "activity" && item.type !== "manual" && "bg-muted")}
                      >
                        <div className="flex flex-col items-end gap-0.5">
                          <span className="flex items-center gap-1">
                            {item.hidden && <EyeOff className="size-3.5 text-muted-foreground" aria-label="Hidden from learners" />}
                            {item.locked && <Lock className="size-3.5 text-muted-foreground" aria-label="Locked" />}
                            {item.activityId ? (
                              <Link href={`/activities/${item.activityId}`} className="hover:underline">
                                {item.name}
                              </Link>
                            ) : (
                              <span>{item.name}</span>
                            )}
                          </span>
                          <span className="text-xs font-normal text-muted-foreground">/ {fmtGrade(item.gradeMax)}</span>
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.users.items.map((user) => (
                    <tr key={user.id} className="border-t">
                      <th scope="row" className="sticky left-0 z-10 bg-background px-3 py-1.5 text-left font-normal">
                        <div className="font-medium">{fullName(user)}</div>
                        {user.email && <div className="text-xs text-muted-foreground">{user.email}</div>}
                      </th>
                      {data.items.map((item) => (
                        <td key={item.id} className={cn("px-1 py-1", item.type !== "activity" && item.type !== "manual" && "bg-muted/40")}>
                          <GradeCell
                            cell={{ item, user, grade: gradeOf.get(`${item.id}:${user.id}`) }}
                            canEdit={data.capabilities.edit}
                            courseId={courseId}
                            onDetails={setDetails}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground">
              <span className="font-semibold text-amber-700 dark:text-amber-400">Bold amber</span> grades are teacher overrides. Shaded columns are calculated totals.
            </p>
            {pages > 1 && (
              <div className="flex items-center justify-center gap-2">
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                  Previous
                </Button>
                <span className="text-sm text-muted-foreground">
                  Page {page} of {pages}
                </span>
                <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>
                  Next
                </Button>
              </div>
            )}
          </>
        ))}
      </QueryState>
      <GradeDetailsDialog cell={details} canEdit={!!data?.capabilities.edit} courseId={courseId} onClose={() => setDetails(null)} />
    </div>
  );
}
