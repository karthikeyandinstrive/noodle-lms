"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ErrorAlert } from "@/components/common";
import { FileInput } from "@/components/file-input";
import { api } from "@/lib/api";
import type { Course } from "@/lib/types";

export type CourseFormValues = {
  fullname: string;
  shortname: string;
  summary: string | null;
  categoryId: string | null;
  visible: boolean;
  startDate: string | null;
  endDate: string | null;
  selfEnrol: "open" | "key" | "closed";
  enrolmentKey?: string | null;
  enableCompletion: boolean;
  imageFileId: string | null;
};

const toDateInput = (v: string | null) => (v ? v.slice(0, 10) : "");

export function CourseForm({
  initial,
  submitLabel,
  onSubmit,
}: {
  initial?: Course;
  submitLabel: string;
  onSubmit: (values: CourseFormValues) => Promise<void>;
}) {
  const categories = useQuery({ queryKey: ["categories"], queryFn: () => api<{ id: string; name: string }[]>("/categories") });
  const [v, setV] = useState<CourseFormValues>({
    fullname: initial?.fullname ?? "",
    shortname: initial?.shortname ?? "",
    summary: initial?.summary ?? "",
    categoryId: initial?.categoryId ?? null,
    visible: initial?.visible ?? true,
    startDate: toDateInput(initial?.startDate ?? null),
    endDate: toDateInput(initial?.endDate ?? null),
    selfEnrol: initial?.selfEnrol ?? "closed",
    enrolmentKey: undefined,
    enableCompletion: initial?.enableCompletion ?? true,
    imageFileId: initial?.imageFileId ?? null,
  });
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const set = <K extends keyof CourseFormValues>(k: K, value: CourseFormValues[K]) => setV((p) => ({ ...p, [k]: value }));

  return (
    <form
      className="max-w-2xl space-y-5"
      onSubmit={async (e) => {
        e.preventDefault();
        setPending(true);
        setError(null);
        try {
          await onSubmit({
            ...v,
            startDate: v.startDate || null,
            endDate: v.endDate || null,
            summary: v.summary || null,
            enrolmentKey: v.selfEnrol === "key" ? v.enrolmentKey : v.enrolmentKey === undefined ? undefined : null,
          });
        } catch (err) {
          setError(err);
        } finally {
          setPending(false);
        }
      }}
    >
      {error ? <ErrorAlert error={error} /> : null}
      <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
        <div className="space-y-1.5">
          <Label htmlFor="fullname">Full name</Label>
          <Input id="fullname" required maxLength={255} value={v.fullname} onChange={(e) => set("fullname", e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="shortname">Short name</Label>
          <Input id="shortname" required maxLength={100} value={v.shortname} onChange={(e) => set("shortname", e.target.value)} />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="category">Category</Label>
        <select
          id="category"
          className="h-8 w-full rounded-lg border bg-background px-2 text-sm"
          value={v.categoryId ?? ""}
          onChange={(e) => set("categoryId", e.target.value || null)}
        >
          <option value="">— None —</option>
          {categories.data?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="summary">Summary</Label>
        <Textarea id="summary" rows={4} value={v.summary ?? ""} onChange={(e) => set("summary", e.target.value)} placeholder="HTML allowed; it is sanitized." />
      </div>
      <div className="space-y-1.5">
        <Label>Course image</Label>
        <FileInput accept="image/*" component="course" area="overview_image" value={v.imageFileId} onChange={(id) => set("imageFileId", id)} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="start">Start date</Label>
          <Input id="start" type="date" value={v.startDate ?? ""} onChange={(e) => set("startDate", e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="end">End date</Label>
          <Input id="end" type="date" value={v.endDate ?? ""} onChange={(e) => set("endDate", e.target.value)} />
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="selfEnrol">Self-enrolment</Label>
          <select id="selfEnrol" className="h-8 w-full rounded-lg border bg-background px-2 text-sm" value={v.selfEnrol} onChange={(e) => set("selfEnrol", e.target.value as CourseFormValues["selfEnrol"])}>
            <option value="closed">Closed</option>
            <option value="open">Open to everyone</option>
            <option value="key">Requires enrolment key</option>
          </select>
        </div>
        {v.selfEnrol === "key" && (
          <div className="space-y-1.5">
            <Label htmlFor="key">Enrolment key</Label>
            <Input id="key" type="password" minLength={4} placeholder={initial ? "Leave blank to keep" : ""} onChange={(e) => set("enrolmentKey", e.target.value || undefined)} />
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-6">
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={v.visible} onCheckedChange={(c) => set("visible", c)} /> Visible to students
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={v.enableCompletion} onCheckedChange={(c) => set("enableCompletion", c)} /> Completion tracking
        </label>
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : submitLabel}
      </Button>
    </form>
  );
}
