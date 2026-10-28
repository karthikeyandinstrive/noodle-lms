"use client";

import { ArrowDown, ArrowUp, ChevronLeft, Lock, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { EmptyState, PageHeader, QueryState } from "@/components/common";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useActivity } from "@/features/activities/use-activity";
import { api, errorMessage } from "@/lib/api";
import { selectClass } from "../assignment/form-utils";
import { useCategories, useQuestions } from "../questionbank/api";
import { TYPE_LABEL, round, useSlotMutation, useSlots, type Slot } from "./api";

export function QuizEditPage() {
  const activity = useActivity();
  const activityId = activity.activityId;
  const slots = useSlots(activityId);
  const [adding, setAdding] = useState(false);

  const reorder = useSlotMutation(activityId, (slotIds: string[]) => api<Slot[]>(`/quizzes/${activityId}/slots/order`, { method: "PUT", body: { slotIds } }));
  const update = useSlotMutation(activityId, ({ id, ...body }: { id: string; maxMark?: number; pinnedVersion?: number | null }) =>
    api<Slot[]>(`/quizzes/${activityId}/slots/${id}`, { method: "PATCH", body }),
  );
  const remove = useSlotMutation(activityId, (id: string) => api<Slot[]>(`/quizzes/${activityId}/slots/${id}`, { method: "DELETE" }));

  const list = slots.data?.slots ?? [];
  const locked = slots.data?.locked ?? false;
  const total = list.reduce((s, x) => s + x.maxMark, 0);
  const onError = (err: unknown) => toast.error(errorMessage(err));

  const move = (i: number, dir: -1 | 1) => {
    const ids = list.map((s) => s.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    reorder.mutate(ids, { onError });
  };

  return (
    <QueryState query={activity}>
      {activity.data && (
        <div>
          <Link href={`/activities/${activityId}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ChevronLeft className="size-4" /> {activity.data.name}
          </Link>
          <PageHeader
            className="mt-2"
            title="Edit quiz questions"
            description={`${list.length} question${list.length === 1 ? "" : "s"} · total ${round(total)} marks`}
            actions={
              <Button onClick={() => setAdding(true)} disabled={locked}>
                <Plus /> Add from question bank
              </Button>
            }
          />
          {locked && (
            <Alert className="mb-4">
              <Lock />
              <AlertDescription>Students have attempted this quiz. You can reorder questions, but not add, remove or re-mark them.</AlertDescription>
            </Alert>
          )}
          <QueryState query={slots}>
            {list.length === 0 ? (
              <EmptyState title="No questions yet" description="Add questions from the course question bank." />
            ) : (
              <ol className="space-y-2">
                {list.map((s, i) => (
                  <li key={s.id} className="flex flex-col gap-3 rounded-xl border p-3 sm:flex-row sm:items-center">
                    <div className="flex items-center gap-1">
                      <Button variant="ghost" size="icon-sm" aria-label="Move up" disabled={i === 0 || reorder.isPending} onClick={() => move(i, -1)}>
                        <ArrowUp />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Move down"
                        disabled={i === list.length - 1 || reorder.isPending}
                        onClick={() => move(i, 1)}
                      >
                        <ArrowDown />
                      </Button>
                      <span className="w-6 text-center text-sm font-medium">{i + 1}</span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{s.name}</div>
                      <div className="flex flex-wrap gap-1 text-xs text-muted-foreground">
                        <Badge variant="outline">{TYPE_LABEL[s.type]}</Badge>
                        {s.deleted && <Badge variant="destructive">Deleted from bank</Badge>}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-end gap-2">
                      <div className="w-24 space-y-1">
                        <Label htmlFor={`mark-${s.id}`} className="text-xs">
                          Mark
                        </Label>
                        <MarkInput
                          key={`${s.id}-${s.maxMark}`}
                          id={`mark-${s.id}`}
                          value={s.maxMark}
                          disabled={locked}
                          onCommit={(maxMark) => update.mutate({ id: s.id, maxMark }, { onError })}
                        />
                      </div>
                      <div className="w-32 space-y-1">
                        <Label htmlFor={`ver-${s.id}`} className="text-xs">
                          Version
                        </Label>
                        <select
                          id={`ver-${s.id}`}
                          className={selectClass}
                          disabled={locked}
                          value={s.pinnedVersion ?? ""}
                          onChange={(e) => update.mutate({ id: s.id, pinnedVersion: e.target.value ? Number(e.target.value) : null }, { onError })}
                        >
                          <option value="">Always latest (v{s.latestVersion})</option>
                          {Array.from({ length: s.latestVersion }, (_, k) => s.latestVersion - k).map((n) => (
                            <option key={n} value={n}>
                              Pin v{n}
                            </option>
                          ))}
                        </select>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Remove ${s.name}`}
                        disabled={locked || remove.isPending}
                        onClick={() => remove.mutate(s.id, { onError })}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </QueryState>
          {adding && <AddQuestionsDialog activityId={activityId} courseId={activity.data.courseId} onClose={() => setAdding(false)} />}
        </div>
      )}
    </QueryState>
  );
}

function MarkInput({ id, value, disabled, onCommit }: { id: string; value: number; disabled?: boolean; onCommit: (n: number) => void }) {
  const [v, setV] = useState(String(value));
  const commit = () => {
    const n = Number(v);
    if (v.trim() === "" || Number.isNaN(n) || n < 0) return setV(String(value));
    if (n !== value) onCommit(n);
  };
  return (
    <Input
      id={id}
      type="number"
      min={0}
      step="any"
      disabled={disabled}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), commit())}
    />
  );
}

function AddQuestionsDialog({ activityId, courseId, onClose }: { activityId: string; courseId: string; onClose: () => void }) {
  const cats = useCategories(courseId);
  const [chosenCategory, setCategoryId] = useState<string | null>(null);
  const categoryId = chosenCategory ?? cats.data?.[0]?.id ?? null;
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const qs = useQuestions(categoryId, courseId, { page, search: search || undefined });
  const add = useSlotMutation(activityId, (questionIds: string[]) => api<Slot[]>(`/quizzes/${activityId}/slots`, { body: { questionIds } }));

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add questions</DialogTitle>
        </DialogHeader>
        <QueryState query={cats}>
          {cats.data && cats.data.length === 0 ? (
            <EmptyState
              title="The question bank is empty"
              action={
                <Button variant="outline" render={<Link href={`/courses/${courseId}/question-bank`} />}>
                  Open question bank
                </Button>
              }
            />
          ) : (
            <div className="space-y-3">
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="add-cat">Category</Label>
                  <select
                    id="add-cat"
                    className={selectClass}
                    value={categoryId ?? ""}
                    onChange={(e) => {
                      setCategoryId(e.target.value);
                      setPage(1);
                    }}
                  >
                    {cats.data?.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({c.questionCount}){c.courseId ? "" : " · shared"}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="add-search">Search</Label>
                  <Input
                    id="add-search"
                    value={search}
                    onChange={(e) => {
                      setSearch(e.target.value);
                      setPage(1);
                    }}
                  />
                </div>
              </div>
              <QueryState query={qs}>
                {qs.data && (
                  <div className="max-h-[50vh] overflow-y-auto rounded-lg border">
                    {qs.data.items.length === 0 ? (
                      <p className="p-4 text-sm text-muted-foreground">No questions found.</p>
                    ) : (
                      <ul className="divide-y">
                        {qs.data.items.map((q) => (
                          <li key={q.id}>
                            <label className="flex cursor-pointer items-center gap-3 p-2.5 text-sm hover:bg-muted/40">
                              <input type="checkbox" className="accent-primary" checked={picked.has(q.id)} onChange={() => toggle(q.id)} />
                              <span className="min-w-0 flex-1 truncate">{q.name}</span>
                              <Badge variant="outline">{TYPE_LABEL[q.type]}</Badge>
                            </label>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </QueryState>
              {qs.data && qs.data.total > qs.data.pageSize && (
                <div className="flex items-center justify-between text-sm">
                  <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage(page - 1)}>
                    Previous
                  </Button>
                  <span className="text-muted-foreground">
                    Page {page} of {Math.ceil(qs.data.total / qs.data.pageSize)}
                  </span>
                  <Button variant="outline" size="sm" disabled={page * qs.data.pageSize >= qs.data.total} onClick={() => setPage(page + 1)}>
                    Next
                  </Button>
                </div>
              )}
            </div>
          )}
        </QueryState>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!picked.size || add.isPending}
            onClick={() =>
              add.mutate([...picked], {
                onSuccess: () => {
                  toast.success(`${picked.size} question${picked.size > 1 ? "s" : ""} added`);
                  onClose();
                },
                onError: (err) => toast.error(errorMessage(err)),
              })
            }
          >
            Add {picked.size || ""} selected
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
