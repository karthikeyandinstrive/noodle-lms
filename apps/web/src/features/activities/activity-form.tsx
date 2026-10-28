"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ErrorAlert } from "@/components/common";
import { RichTextEditor } from "@/components/rich-text-editor";
import { useT } from "@/lib/i18n";
import type { ActivityDetail, ActivityType, CompletionRule, Section } from "@/lib/types";
import { activityRegistry, activityTypeDescription, activityTypeLabel, activityTypes } from "./registry";

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

const COMPLETION_LABELS: Record<CompletionRule, { key: string; label: string }> = {
  none: { key: "activity.completionRule.none", label: "Do not track" },
  manual: { key: "activity.completionRule.manual", label: "Students mark it complete" },
  view: { key: "activity.completionRule.view", label: "Viewed" },
  submit: { key: "activity.completionRule.submit", label: "Submitted / participated" },
  grade: { key: "activity.completionRule.grade", label: "Received a grade" },
  pass: { key: "activity.completionRule.pass", label: "Received a passing grade" },
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
  const t = useT();
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
        {activityTypes.map((at) => (
          <button
            key={at.type}
            type="button"
            onClick={() => {
              setType(at.type);
              setV((p) => ({ ...p, settings: { ...at.defaults }, completionRule: at.defaultCompletion ?? p.completionRule }));
            }}
            className="flex items-start gap-3 rounded-xl border p-4 text-left transition-colors hover:border-primary hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <at.icon aria-hidden className="mt-0.5 size-5 text-primary" />
            <div>
              <div className="font-medium">{activityTypeLabel(t, at.type)}</div>
              <div className="text-sm text-muted-foreground">{activityTypeDescription(t, at.type)}</div>
            </div>
          </button>
        ))}
      </div>
    );
  }

  const ui = activityRegistry[type];
  const typeLabel = activityTypeLabel(t, type);
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
            <ui.icon aria-hidden className="size-5 text-primary" /> {typeLabel}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="name">{t("common.name", "Name")}</Label>
            <Input id="name" required maxLength={255} value={v.name} onChange={(e) => set("name", e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="description">{t("common.description", "Description")}</Label>
            <RichTextEditor id="description" value={v.description ?? ""} onChange={(html) => set("description", html)} minHeight={96} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="section">{t("activity.section", "Section")}</Label>
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
          <CardTitle>{t("activity.typeSettings", "{type} settings", { type: typeLabel })}</CardTitle>
        </CardHeader>
        <CardContent>
          <ui.SettingsFields value={v.settings} onChange={(settings) => set("settings", settings)} mode={initial ? "edit" : "create"} courseId={courseId} activityId={initial?.id} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("activity.availabilityCompletion", "Availability & completion")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="from">{t("activity.availableFrom", "Available from")}</Label>
            <Input id="from" type="datetime-local" value={toLocalInput(v.availableFrom)} onChange={(e) => set("availableFrom", fromLocalInput(e.target.value))} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="until">{t("activity.availableUntil", "Available until")}</Label>
            <Input id="until" type="datetime-local" value={toLocalInput(v.availableUntil)} onChange={(e) => set("availableUntil", fromLocalInput(e.target.value))} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="completion">{t("activity.completionTracking", "Completion tracking")}</Label>
            <select id="completion" className="h-8 w-full rounded-lg border bg-background px-2 text-sm" value={v.completionRule} onChange={(e) => set("completionRule", e.target.value as CompletionRule)}>
              {Object.entries(COMPLETION_LABELS).map(([k, o]) => (
                <option key={k} value={k}>
                  {t(o.key, o.label)}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="groupMode">{t("activity.groupMode", "Group mode")}</Label>
            <select id="groupMode" className="h-8 w-full rounded-lg border bg-background px-2 text-sm" value={v.groupMode} onChange={(e) => set("groupMode", e.target.value as ActivityFormValues["groupMode"])}>
              <option value="none">{t("activity.groupMode.none", "No groups")}</option>
              <option value="separate">{t("activity.groupMode.separate", "Separate groups")}</option>
              <option value="visible">{t("activity.groupMode.visible", "Visible groups")}</option>
            </select>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={v.visible} onCheckedChange={(c) => set("visible", c)} /> {t("activity.visibleToStudents", "Visible to students")}
          </label>
        </CardContent>
      </Card>

      <div className="flex gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? t("common.saving", "Saving…") : initial ? t("activity.saveChanges", "Save changes") : t("course.addActivity", "Add activity")}
        </Button>
        {!initial && (
          <Button type="button" variant="ghost" onClick={() => setType(undefined)}>
            {t("activity.chooseAnotherType", "Choose another type")}
          </Button>
        )}
      </div>
    </form>
  );
}
