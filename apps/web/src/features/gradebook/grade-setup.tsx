"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { QueryState } from "@/components/common";
import { api, errorMessage } from "@/lib/api";
import { NativeSelect } from "./native-select";
import { AGGREGATION_LABELS, fmtGrade, gradesKey, type Aggregation, type GradeCategory, type GradeItem } from "./types";

type Setup = { categories: GradeCategory[]; items: GradeItem[] };

const TYPE_LABELS: Record<GradeItem["type"], string> = { activity: "Activity", manual: "Manual", category: "Category total", course: "Course total" };

function useSetup(courseId: string) {
  return useQuery({ queryKey: [...gradesKey(courseId), "setup"], queryFn: () => api<Setup>(`/grades/courses/${courseId}/setup`) });
}

function useRun(courseId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => qc.invalidateQueries({ queryKey: gradesKey(courseId) }),
    onError: (e) => toast.error(errorMessage(e)),
  });
}

/** Category path label, e.g. "Course › Homework › Labs". */
function categoryLabels(categories: GradeCategory[]) {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const label = (c: GradeCategory, depth = 0): string => {
    if (!c.parentId || depth > 10) return c.parentId ? c.name : "Course (top level)";
    const parent = byId.get(c.parentId);
    return parent && parent.parentId ? `${label(parent, depth + 1)} › ${c.name}` : c.name;
  };
  return new Map(categories.map((c) => [c.id, label(c)]));
}

function CategoryRow({ category, categories, courseId }: { category: GradeCategory; categories: GradeCategory[]; courseId: string }) {
  const run = useRun(courseId);
  const isRoot = !category.parentId;
  const [form, setForm] = useState({
    name: category.name,
    aggregation: category.aggregation,
    dropLowest: String(category.dropLowest),
    weight: String(category.weight ?? 1),
    parentId: category.parentId ?? "",
  });
  const labels = categoryLabels(categories);
  const idp = `cat-${category.id}`;
  return (
    <form
      className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2 lg:grid-cols-[2fr_1.5fr_1.5fr_0.7fr_0.7fr_auto] lg:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        const body: Record<string, unknown> = { name: form.name, aggregation: form.aggregation, dropLowest: Number(form.dropLowest) || 0 };
        if (!isRoot) {
          body.weight = Number(form.weight);
          if (form.parentId && form.parentId !== category.parentId) body.parentId = form.parentId;
        }
        run.mutate(() => api(`/grades/categories/${category.id}`, { method: "PATCH", body }), { onSuccess: () => toast.success("Category saved") });
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor={`${idp}-name`}>{isRoot ? "Course category" : "Name"}</Label>
        <Input id={`${idp}-name`} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={255} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idp}-parent`}>Parent</Label>
        {isRoot ? (
          <p className="h-8 text-sm leading-8 text-muted-foreground">—</p>
        ) : (
          <NativeSelect id={`${idp}-parent`} className="w-full" value={form.parentId} onChange={(e) => setForm({ ...form, parentId: e.target.value })}>
            {categories
              .filter((c) => c.id !== category.id)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {labels.get(c.id)}
                </option>
              ))}
          </NativeSelect>
        )}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idp}-agg`}>Aggregation</Label>
        <NativeSelect id={`${idp}-agg`} className="w-full" value={form.aggregation} onChange={(e) => setForm({ ...form, aggregation: e.target.value as Aggregation })}>
          {Object.entries(AGGREGATION_LABELS).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idp}-drop`}>Drop lowest</Label>
        <Input id={`${idp}-drop`} type="number" min={0} max={100} value={form.dropLowest} onChange={(e) => setForm({ ...form, dropLowest: e.target.value })} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idp}-weight`}>Weight</Label>
        <Input
          id={`${idp}-weight`}
          type="number"
          min={0}
          step="any"
          disabled={isRoot}
          value={isRoot ? "" : form.weight}
          onChange={(e) => setForm({ ...form, weight: e.target.value })}
        />
      </div>
      <div className="flex gap-1">
        <Button type="submit" size="sm" disabled={run.isPending}>
          Save
        </Button>
        {!isRoot && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Delete category ${category.name}`}
            onClick={() => {
              if (confirm(`Delete "${category.name}"? Its items move to the parent category.`)) {
                run.mutate(() => api(`/grades/categories/${category.id}`, { method: "DELETE" }), { onSuccess: () => toast.success("Category deleted") });
              }
            }}
          >
            <Trash2 />
          </Button>
        )}
      </div>
    </form>
  );
}

function NewCategoryForm({ categories, courseId }: { categories: GradeCategory[]; courseId: string }) {
  const run = useRun(courseId);
  const root = categories.find((c) => !c.parentId);
  const labels = categoryLabels(categories);
  const empty = { name: "", parentId: root?.id ?? "", aggregation: "weighted_mean" as Aggregation, weight: "1" };
  const [form, setForm] = useState(empty);
  return (
    <form
      className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[2fr_1.5fr_1.5fr_0.7fr_auto] lg:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        run.mutate(
          () => api(`/grades/courses/${courseId}/categories`, { body: { name: form.name, parentId: form.parentId || null, aggregation: form.aggregation, weight: Number(form.weight) } }),
          {
            onSuccess: () => {
              toast.success("Category added");
              setForm(empty);
            },
          },
        );
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="newcat-name">New category</Label>
        <Input id="newcat-name" placeholder="e.g. Homework" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={255} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="newcat-parent">Parent</Label>
        <NativeSelect id="newcat-parent" className="w-full" value={form.parentId} onChange={(e) => setForm({ ...form, parentId: e.target.value })}>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {labels.get(c.id)}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="newcat-agg">Aggregation</Label>
        <NativeSelect id="newcat-agg" className="w-full" value={form.aggregation} onChange={(e) => setForm({ ...form, aggregation: e.target.value as Aggregation })}>
          {Object.entries(AGGREGATION_LABELS).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="newcat-weight">Weight</Label>
        <Input id="newcat-weight" type="number" min={0} step="any" value={form.weight} onChange={(e) => setForm({ ...form, weight: e.target.value })} />
      </div>
      <Button type="submit" disabled={run.isPending}>
        <Plus /> Add
      </Button>
    </form>
  );
}

function NewItemForm({ categories, courseId }: { categories: GradeCategory[]; courseId: string }) {
  const run = useRun(courseId);
  const root = categories.find((c) => !c.parentId);
  const labels = categoryLabels(categories);
  const empty = { name: "", categoryId: root?.id ?? "", gradeMax: "100", gradePass: "", weight: "1" };
  const [form, setForm] = useState(empty);
  return (
    <form
      className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[2fr_1.5fr_0.8fr_0.8fr_0.8fr_auto] lg:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        run.mutate(
          () =>
            api(`/grades/courses/${courseId}/items`, {
              body: {
                name: form.name,
                categoryId: form.categoryId || null,
                gradeMax: Number(form.gradeMax),
                gradePass: form.gradePass === "" ? null : Number(form.gradePass),
                weight: Number(form.weight),
              },
            }),
          {
            onSuccess: () => {
              toast.success("Grade item added");
              setForm(empty);
            },
          },
        );
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="newitem-name">New manual item</Label>
        <Input id="newitem-name" placeholder="e.g. Participation" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={255} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="newitem-cat">Category</Label>
        <NativeSelect id="newitem-cat" className="w-full" value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })}>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {labels.get(c.id)}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="newitem-max">Max grade</Label>
        <Input id="newitem-max" type="number" min={0.01} step="any" value={form.gradeMax} onChange={(e) => setForm({ ...form, gradeMax: e.target.value })} required />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="newitem-pass">Pass grade</Label>
        <Input id="newitem-pass" type="number" min={0} step="any" value={form.gradePass} onChange={(e) => setForm({ ...form, gradePass: e.target.value })} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="newitem-weight">Weight</Label>
        <Input id="newitem-weight" type="number" min={0} step="any" value={form.weight} onChange={(e) => setForm({ ...form, weight: e.target.value })} />
      </div>
      <Button type="submit" disabled={run.isPending}>
        <Plus /> Add
      </Button>
    </form>
  );
}

function WeightInput({ item, courseId }: { item: GradeItem; courseId: string }) {
  const run = useRun(courseId);
  const [value, setValue] = useState(String(item.weight));
  const save = () => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) {
      setValue(String(item.weight));
      return toast.error("Weight must be a positive number");
    }
    if (n !== item.weight) run.mutate(() => api(`/grades/items/${item.id}`, { method: "PATCH", body: { weight: n } }));
  };
  return (
    <Input
      type="number"
      min={0}
      step="any"
      className="h-7 w-20"
      aria-label={`Weight of ${item.name}`}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), save())}
    />
  );
}

function ItemsTable({ setup, courseId }: { setup: Setup; courseId: string }) {
  const run = useRun(courseId);
  const labels = categoryLabels(setup.categories);
  const leaves = setup.items.filter((i) => i.type === "activity" || i.type === "manual");
  const totals = setup.items.filter((i) => i.type === "category" || i.type === "course");
  const patch = (item: GradeItem, body: Record<string, unknown>) => run.mutate(() => api(`/grades/items/${item.id}`, { method: "PATCH", body }));
  const move = (from: number, to: number) => {
    const ids = leaves.map((i) => i.id);
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved!);
    run.mutate(() => api(`/grades/courses/${courseId}/items/order`, { method: "PUT", body: { itemIds: ids } }));
  };

  const row = (item: GradeItem, index: number | null) => (
    <tr key={item.id} className="border-t">
      <th scope="row" className="px-3 py-2 text-left font-normal">
        <div className="font-medium">{item.name}</div>
        <Badge variant="secondary" className="mt-0.5">
          {TYPE_LABELS[item.type]}
        </Badge>
      </th>
      <td className="px-3 py-2">
        {index !== null ? (
          <NativeSelect aria-label={`Category of ${item.name}`} value={item.categoryId ?? ""} onChange={(e) => patch(item, { categoryId: e.target.value })}>
            {setup.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {labels.get(c.id)}
              </option>
            ))}
          </NativeSelect>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">{fmtGrade(item.gradeMax)}</td>
      <td className="px-3 py-2">{item.type === "course" ? <span className="text-muted-foreground">—</span> : <WeightInput key={item.weight} item={item} courseId={courseId} />}</td>
      <td className="px-3 py-2">
        <Switch aria-label={`Hide ${item.name} from learners`} checked={item.hidden} onCheckedChange={(hidden) => patch(item, { hidden })} />
      </td>
      <td className="px-3 py-2">
        <Switch aria-label={`Lock ${item.name}`} checked={item.locked} onCheckedChange={(locked) => patch(item, { locked })} />
      </td>
      <td className="px-3 py-2">
        <div className="flex justify-end gap-1">
          {index !== null && (
            <>
              <Button variant="ghost" size="icon-sm" aria-label={`Move ${item.name} up`} disabled={index === 0} onClick={() => move(index, index - 1)}>
                <ArrowUp />
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label={`Move ${item.name} down`} disabled={index === leaves.length - 1} onClick={() => move(index, index + 1)}>
                <ArrowDown />
              </Button>
            </>
          )}
          {item.type === "manual" && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Delete ${item.name}`}
              onClick={() => {
                if (confirm(`Delete "${item.name}" and all its grades?`)) run.mutate(() => api(`/grades/items/${item.id}`, { method: "DELETE" }));
              }}
            >
              <Trash2 />
            </Button>
          )}
        </div>
      </td>
    </tr>
  );

  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full min-w-[720px] text-sm">
        <caption className="sr-only">Grade items</caption>
        <thead className="bg-muted/50 text-left">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">Item</th>
            <th scope="col" className="px-3 py-2 font-medium">Category</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Max</th>
            <th scope="col" className="px-3 py-2 font-medium">Weight</th>
            <th scope="col" className="px-3 py-2 font-medium">Hidden</th>
            <th scope="col" className="px-3 py-2 font-medium">Locked</th>
            <th scope="col" className="px-3 py-2 text-right font-medium"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {leaves.map((item, i) => row(item, i))}
          {totals.map((item) => row(item, null))}
        </tbody>
      </table>
    </div>
  );
}

export function GradeSetup({ courseId }: { courseId: string }) {
  const setup = useSetup(courseId);
  return (
    <QueryState query={setup}>
      {setup.data && (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Categories</CardTitle>
              <CardDescription>
                Each category aggregates its items as a percentage; a category&apos;s weight applies inside its parent. The course category produces the course total.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {setup.data.categories.map((c) => (
                <CategoryRow key={`${c.id}-${c.name}-${c.aggregation}-${c.dropLowest}-${c.weight}-${c.parentId}`} category={c} categories={setup.data.categories} courseId={courseId} />
              ))}
              <div className="border-t pt-4">
                <NewCategoryForm categories={setup.data.categories} courseId={courseId} />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Grade items</CardTitle>
              <CardDescription>Activity items are created by gradable activities. Hidden items are not shown to learners; locked items cannot be changed.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <ItemsTable setup={setup.data} courseId={courseId} />
              <div className="border-t pt-4">
                <NewItemForm categories={setup.data.categories} courseId={courseId} />
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </QueryState>
  );
}
