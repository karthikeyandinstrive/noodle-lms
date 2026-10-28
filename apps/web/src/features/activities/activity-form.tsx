"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ErrorAlert } from "@/components/common";
import type { ActivityDetail, ActivityType, CompletionRule, Section } from "@/lib/types";
import { activityRegistry, activityTypes } from "./registry";

export type ActivityFormValues = {
  type: ActivityType;
  sectionId: string;
  name: string;
  description: string | null;
  visible: boolean;
  availableFrom: string | null;
  availableUntil: string | null;
  completionRule: CompletionRule;
  groupMode: "none" | "separate" | "visible";
  settings: Record<string, unknown>;
};

const COMPLETION_LABELS: Record<CompletionRule, string> = {
  none: "Do not track",
  manual: "Students mark it complete",
  view: "Viewed",
  submit: "Submitted / participated",
  grade: "Received a grade",
  pass: "Received a passing grade",
};

/** Converts an ISO string to the value format of <input type="datetime-local">. */
const toLocalInput = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : null);

export function ActivityForm({
  courseId,
  sections,
  initial,
  initialType,
  initialSectionId,
  onSubmit,
}: {
  courseId: string;
  sections: Section[];
  initial?: ActivityDetail;
  initialType?: ActivityType;
  initialSectionId?: string;
  onSubmit: (values: ActivityFormValues) => Promise<void>;
}) {
  const [type, setType] = useState<ActivityType | undefined>(initial?.type ?? initialType);
  const [v, setV] = useState<Omit<ActivityFormValues, "type">>({
    sectionId: initial?.sectionId ?? initialSectionId ?? sections[0]?.id ?? "",
    name: initial?.name ?? "",
    description: initial?.description ?? "",
    visible: initial?.visible ?? true,
    availableFrom: initial?.availableFrom ?? null,
    availableUntil: initial?.availableUntil ?? null,
    completionRule: initial?.completionRule ?? (initialType ? activityRegistry[initialType].defaultCompletion : undefined) ?? "none",
    groupMode: (initial?.groupMode as ActivityFormValues["groupMode"]) ?? "none",
    settings: initial?.settings ?? (initialType ? { ...activityRegistry[initialType].defaults } : {}),
  });
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);

  if (!type) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {activityTypes.map((t) => (
          <button
            key={t.type}
            type="button"
            onClick={() => {
              setType(t.type);
              setV((p) => ({ ...p, settings: { ...t.defaults }, completionRule: t.defaultCompletion ?? p.completionRule }));
            }}
            className="flex items-start gap-3 rounded-xl border p-4 text-left transition-colors hover:border-primary hover:bg-muted/50"
          >
            <t.icon className="mt-0.5 size-5 text-primary" />
            <div>
              <div className="font-medium">{t.label}</div>
              <div className="text-sm text-muted-foreground">{t.description}</div>
            </div>
          </button>
        ))}
      </div>
    );
  }

  const ui = activityRegistry[type];
  const set = <K extends keyof typeof v>(k: K, value: (typeof v)[K]) => setV((p) => ({ ...p, [k]: value }));

  return (
    <form
      className="max-w-3xl space-y-6"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        setPending(true);
        try {
          await onSubmit({ ...v, type, description: v.description || null });
        } catch (err) {
          setError(err);
        } finally {
          setPending(false);
        }
      }}
    >
      {error ? <ErrorAlert error={error} /> : null}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ui.icon className="size-5 text-primary" /> {ui.label}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="name">Name</Label>
            <Input id="name" required maxLength={255} value={v.name} onChange={(e) => set("name", e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="description">Description</Label>
            <Textarea id="description" rows={3} value={v.description ?? ""} onChange={(e) => set("description", e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="section">Section</Label>
            <select id="section" className="h-8 w-full rounded-lg border bg-background px-2 text-sm" value={v.sectionId} onChange={(e) => set("sectionId", e.target.value)}>
              {sections.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{ui.label} settings</CardTitle>
        </CardHeader>
        <CardContent>
          <ui.SettingsFields value={v.settings} onChange={(settings) => set("settings", settings)} mode={initial ? "edit" : "create"} courseId={courseId} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Availability & completion</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="from">Available from</Label>
            <Input id="from" type="datetime-local" value={toLocalInput(v.availableFrom)} onChange={(e) => set("availableFrom", fromLocalInput(e.target.value))} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="until">Available until</Label>
            <Input id="until" type="datetime-local" value={toLocalInput(v.availableUntil)} onChange={(e) => set("availableUntil", fromLocalInput(e.target.value))} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="completion">Completion tracking</Label>
            <select id="completion" className="h-8 w-full rounded-lg border bg-background px-2 text-sm" value={v.completionRule} onChange={(e) => set("completionRule", e.target.value as CompletionRule)}>
              {Object.entries(COMPLETION_LABELS).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="groupMode">Group mode</Label>
            <select id="groupMode" className="h-8 w-full rounded-lg border bg-background px-2 text-sm" value={v.groupMode} onChange={(e) => set("groupMode", e.target.value as ActivityFormValues["groupMode"])}>
              <option value="none">No groups</option>
              <option value="separate">Separate groups</option>
              <option value="visible">Visible groups</option>
            </select>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={v.visible} onCheckedChange={(c) => set("visible", c)} /> Visible to students
          </label>
        </CardContent>
      </Card>

      <div className="flex gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : initial ? "Save changes" : "Add activity"}
        </Button>
        {!initial && (
          <Button type="button" variant="ghost" onClick={() => setType(undefined)}>
            Choose another type
          </Button>
        )}
      </div>
    </form>
  );
}
