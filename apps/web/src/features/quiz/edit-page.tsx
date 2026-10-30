"use client";

import { ArrowDown, ArrowUp, ChevronLeft, Lock, Plus, Shuffle, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { EmptyState, PageHeader, QueryState } from "@/components/common";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useActivity } from "@/features/activities/use-activity";
import { api, errorMessage } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { SwitchField, selectClass } from "../assignment/form-utils";
import { useCategories, useQuestions } from "../questionbank/api";
import { round, typeLabel, useSlotMutation, useSlots, type Slot } from "./api";

export function QuizEditPage() {
  const activity = useActivity();
  const activityId = activity.activityId;
  const slots = useSlots(activityId);
  const [adding, setAdding] = useState(false);
  const [addingRandom, setAddingRandom] = useState(false);
  const t = useT();

  const reorder = useSlotMutation(activityId, (slotIds: string[]) =>
    api<Slot[]>(`/quizzes/${activityId}/slots/order`, {
      method: "PUT",
      body: { slotIds },
    }),
  );
  const update = useSlotMutation(activityId, ({ id, ...body }: { id: string; maxMark?: number; pinnedVersion?: number | null }) =>
    api<Slot[]>(`/quizzes/${activityId}/slots/${id}`, {
      method: "PATCH",
      body,
    }),
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
            <ChevronLeft aria-hidden className="size-4" /> {activity.data.name}
          </Link>
          <PageHeader
            className="mt-2"
            title={t("quiz.edit.title", "Edit quiz questions")}
            description={
              list.length === 1
                ? t("quiz.edit.summary.one", "{count} question · total {marks} marks", { count: list.length, marks: round(total) })
                : t("quiz.edit.summary.other", "{count} questions · total {marks} marks", { count: list.length, marks: round(total) })
            }
            actions={
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => setAddingRandom(true)} disabled={locked}>
                  <Shuffle aria-hidden /> {t("quiz.edit.addRandom", "Add random questions")}
                </Button>
                <Button onClick={() => setAdding(true)} disabled={locked}>
                  <Plus aria-hidden /> {t("quiz.edit.addFromBank", "Add from question bank")}
                </Button>
              </div>
            }
          />
          {locked && (
            <Alert className="mb-4">
              <Lock aria-hidden />
              <AlertDescription>
                {t("quiz.edit.lockedNotice", "Students have attempted this quiz. You can reorder questions, but not add, remove or re-mark them.")}
              </AlertDescription>
            </Alert>
          )}
          <QueryState query={slots}>
            {list.length === 0 ? (
              <EmptyState
                title={t("quiz.edit.noQuestions", "No questions yet")}
                description={t("quiz.edit.noQuestionsHint", "Add questions from the course question bank.")}
              />
            ) : (
              <ol className="space-y-2">
                {list.map((s, i) => (
                  <li key={s.id} className="flex flex-col gap-3 rounded-xl border p-3 sm:flex-row sm:items-center">
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("quiz.edit.moveUp", "Move {name} up", {
                          name: s.name,
                        })}
                        disabled={i === 0 || reorder.isPending}
                        onClick={() => move(i, -1)}
                      >
                        <ArrowUp aria-hidden />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("quiz.edit.moveDown", "Move {name} down", { name: s.name })}
                        disabled={i === list.length - 1 || reorder.isPending}
                        onClick={() => move(i, 1)}
                      >
                        <ArrowDown aria-hidden />
                      </Button>
                      <span className="w-6 text-center text-sm font-medium">{i + 1}</span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">
                        {s.random
                          ? s.random.includeSubcategories
                            ? t("quiz.edit.randomFromSub", "Random question from “{category}” and its subcategories", { category: s.random.categoryName })
                            : t("quiz.edit.randomFrom", "Random question from “{category}”", { category: s.random.categoryName })
                          : s.name}
                      </div>
                      <div className="flex flex-wrap gap-1 text-xs text-muted-foreground">
                        {s.type ? (
                          <Badge variant="outline">{typeLabel(t, s.type)}</Badge>
                        ) : (
                          <Badge variant="secondary">
                            <Shuffle aria-hidden /> {t("quiz.edit.random", "Random")}
                          </Badge>
                        )}
                        {s.random && (
                          <span className={s.random.available === 0 ? "text-destructive" : undefined}>
                            {t("quiz.edit.randomAvailable", "{count} question(s) to draw from", { count: s.random.available })}
                          </span>
                        )}
                        {s.deleted && <Badge variant="destructive">{t("quiz.edit.deletedFromBank", "Deleted from bank")}</Badge>}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-end gap-2">
                      <div className="w-24 space-y-1">
                        <Label htmlFor={`mark-${s.id}`} className="text-xs">
                          {t("quiz.edit.mark", "Mark")}
                        </Label>
                        <MarkInput
                          key={`${s.id}-${s.maxMark}`}
                          id={`mark-${s.id}`}
                          value={s.maxMark}
                          disabled={locked}
                          onCommit={(maxMark) => update.mutate({ id: s.id, maxMark }, { onError })}
                        />
                      </div>
                      {s.latestVersion !== null && (
                        <div className="w-32 space-y-1">
                          <Label htmlFor={`ver-${s.id}`} className="text-xs">
                            {t("quiz.edit.version", "Version")}
                          </Label>
                          <select
                            id={`ver-${s.id}`}
                            className={selectClass}
                            disabled={locked}
                            value={s.pinnedVersion ?? ""}
                            onChange={(e) =>
                              update.mutate(
                                {
                                  id: s.id,
                                  pinnedVersion: e.target.value ? Number(e.target.value) : null,
                                },
                                { onError },
                              )
                            }
                          >
                            <option value="">{t("quiz.edit.alwaysLatest", "Always latest (v{version})", { version: s.latestVersion })}</option>
                            {Array.from({ length: s.latestVersion }, (_, k) => s.latestVersion! - k).map((n) => (
                              <option key={n} value={n}>
                                {t("quiz.edit.pinVersion", "Pin v{version}", {
                                  version: n,
                                })}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("quiz.edit.remove", "Remove {name}", {
                          name: s.name,
                        })}
                        disabled={locked || remove.isPending}
                        onClick={() => remove.mutate(s.id, { onError })}
                      >
                        <Trash2 aria-hidden />
                      </Button>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </QueryState>
          {adding && <AddQuestionsDialog activityId={activityId} courseId={activity.data.courseId} onClose={() => setAdding(false)} />}
          {addingRandom && <AddRandomDialog activityId={activityId} courseId={activity.data.courseId} onClose={() => setAddingRandom(false)} />}
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
  const qs = useQuestions(categoryId, courseId, {
    page,
    search: search || undefined,
  });
  const add = useSlotMutation(activityId, (questionIds: string[]) => api<Slot[]>(`/quizzes/${activityId}/slots`, { body: { questionIds } }));
  const t = useT();

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
          <DialogTitle>{t("quiz.edit.addQuestions", "Add questions")}</DialogTitle>
        </DialogHeader>
        <QueryState query={cats}>
          {cats.data && cats.data.length === 0 ? (
            <EmptyState
              title={t("quiz.edit.bankEmpty", "The question bank is empty")}
              action={
                <Link href={`/courses/${courseId}/question-bank`} className={buttonVariants({ variant: "outline" })}>
                  {t("quiz.edit.openBank", "Open question bank")}
                </Link>
              }
            />
          ) : (
            <div className="space-y-3">
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="add-cat">{t("quiz.edit.category", "Category")}</Label>
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
                        {c.courseId
                          ? t("quiz.edit.categoryOption", "{name} ({count})", {
                              name: c.name,
                              count: c.questionCount,
                            })
                          : t("quiz.edit.categoryOptionShared", "{name} ({count}) · shared", { name: c.name, count: c.questionCount })}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="add-search">{t("common.search", "Search")}</Label>
                  <Input
                    id="add-search"
                    type="search"
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
                      <p className="p-4 text-sm text-muted-foreground" role="status">
                        {t("quiz.edit.noneFound", "No questions found.")}
                      </p>
                    ) : (
                      <ul className="divide-y" aria-label={t("quiz.edit.questionList", "Questions")}>
                        {qs.data.items.map((q) => (
                          <li key={q.id}>
                            <label className="flex cursor-pointer items-center gap-3 p-2.5 text-sm hover:bg-muted/40">
                              <input
                                type="checkbox"
                                className="accent-primary focus-visible:ring-2 focus-visible:ring-ring"
                                checked={picked.has(q.id)}
                                onChange={() => toggle(q.id)}
                              />
                              <span className="min-w-0 flex-1 truncate">{q.name}</span>
                              <Badge variant="outline">{typeLabel(t, q.type)}</Badge>
                            </label>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </QueryState>
              {qs.data && qs.data.total > qs.data.pageSize && (
                <nav className="flex items-center justify-between text-sm" aria-label={t("quiz.edit.pagination", "Question bank pages")}>
                  <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage(page - 1)}>
                    {t("common.previous", "Previous")}
                  </Button>
                  <span className="text-muted-foreground">
                    {t("quiz.pageOf", "Page {page} of {pages}", {
                      page,
                      pages: Math.ceil(qs.data.total / qs.data.pageSize),
                    })}
                  </span>
                  <Button variant="outline" size="sm" disabled={page * qs.data.pageSize >= qs.data.total} onClick={() => setPage(page + 1)}>
                    {t("common.next", "Next")}
                  </Button>
                </nav>
              )}
            </div>
          )}
        </QueryState>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("common.cancel", "Cancel")}
          </Button>
          <Button
            disabled={!picked.size || add.isPending}
            onClick={() =>
              add.mutate([...picked], {
                onSuccess: () => {
                  toast.success(
                    picked.size === 1
                      ? t("quiz.edit.added.one", "{count} question added", {
                          count: picked.size,
                        })
                      : t("quiz.edit.added.other", "{count} questions added", {
                          count: picked.size,
                        }),
                  );
                  onClose();
                },
                onError: (err) => toast.error(errorMessage(err)),
              })
            }
          >
            {picked.size
              ? t("quiz.edit.addSelectedCount", "Add {count} selected", {
                  count: picked.size,
                })
              : t("quiz.edit.addSelected", "Add selected")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Random slots: each attempt draws a different question from the category (never one already in the attempt). */
function AddRandomDialog({ activityId, courseId, onClose }: { activityId: string; courseId: string; onClose: () => void }) {
  const t = useT();
  const cats = useCategories(courseId);
  const [chosenCategory, setCategoryId] = useState<string | null>(null);
  const categoryId = chosenCategory ?? cats.data?.[0]?.id ?? null;
  const [includeSubcategories, setInclude] = useState(false);
  const [count, setCount] = useState(1);
  const [maxMark, setMaxMark] = useState(1);
  const add = useSlotMutation(activityId, (body: { categoryId: string; includeSubcategories: boolean; count: number; maxMark: number }) =>
    api<Slot[]>(`/quizzes/${activityId}/random-slots`, { body }),
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("quiz.edit.addRandom", "Add random questions")}</DialogTitle>
        </DialogHeader>
        <QueryState query={cats}>
          <form
            id="random-form"
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!categoryId) return;
              add.mutate(
                { categoryId, includeSubcategories, count, maxMark },
                {
                  onSuccess: () => {
                    toast.success(t("quiz.edit.randomAdded", "{count} random question(s) added", { count }));
                    onClose();
                  },
                  onError: (err) => toast.error(errorMessage(err)),
                },
              );
            }}
          >
            <p className="text-sm text-muted-foreground">
              {t(
                "quiz.edit.randomHint",
                "Each attempt gets a different question drawn from the category. A question already in the attempt is never drawn twice.",
              )}
            </p>
            <div className="space-y-1">
              <Label htmlFor="rnd-cat">{t("quiz.edit.category", "Category")}</Label>
              <select id="rnd-cat" className={selectClass} value={categoryId ?? ""} onChange={(e) => setCategoryId(e.target.value)}>
                {cats.data?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.courseId
                      ? t("quiz.edit.categoryOption", "{name} ({count})", {
                          name: c.name,
                          count: c.questionCount,
                        })
                      : t("quiz.edit.categoryOptionShared", "{name} ({count}) · shared", { name: c.name, count: c.questionCount })}
                  </option>
                ))}
              </select>
            </div>
            <SwitchField
              label={t("quiz.edit.includeSubcategories", "Include questions from subcategories")}
              checked={includeSubcategories}
              onChange={setInclude}
            />
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label htmlFor="rnd-count">{t("quiz.edit.randomCount", "Number of questions")}</Label>
                <Input
                  id="rnd-count"
                  type="number"
                  min={1}
                  max={100}
                  step={1}
                  required
                  value={count}
                  onChange={(e) => setCount(Math.max(1, Math.min(100, Math.round(Number(e.target.value)) || 1)))}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="rnd-mark">{t("quiz.edit.markEach", "Mark for each")}</Label>
                <Input
                  id="rnd-mark"
                  type="number"
                  min={0}
                  step="any"
                  required
                  value={maxMark}
                  onChange={(e) => setMaxMark(Math.max(0, Number(e.target.value)))}
                />
              </div>
            </div>
          </form>
        </QueryState>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("common.cancel", "Cancel")}
          </Button>
          <Button type="submit" form="random-form" disabled={!categoryId || add.isPending}>
            {t("quiz.edit.addRandomSubmit", "Add random questions")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
