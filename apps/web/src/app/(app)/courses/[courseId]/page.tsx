"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, CheckCircle2, Circle, EyeOff, Pencil, Plus, Trash2, XCircle } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { EmptyState, HtmlContent } from "@/components/common";
import { activityRegistry } from "@/features/activities/registry";
import { formatPrice } from "@/features/courses/course-list";
import { courseKey, useCourse } from "@/features/courses/use-course";
import { api, errorMessage } from "@/lib/api";
import type { ActivitySummary, CourseOverview, Section } from "@/lib/types";

function CompletionIcon({ activity, onToggle }: { activity: ActivitySummary; onToggle?: () => void }) {
  if (activity.completion === null) return null;
  const done = activity.completion === "complete" || activity.completion === "complete_pass";
  const failed = activity.completion === "complete_fail";
  const icon = done ? <CheckCircle2 className="size-5 text-green-600" /> : failed ? <XCircle className="size-5 text-destructive" /> : <Circle className="size-5 text-muted-foreground" />;
  const label = done ? "Completed" : failed ? "Completed (not passed)" : "Not completed";
  if (activity.completionRule === "manual" && onToggle) {
    return (
      <button type="button" onClick={onToggle} aria-label={`${label} — click to toggle`} title={`${label} — click to toggle`}>
        {icon}
      </button>
    );
  }
  return <span title={label} aria-label={label}>{icon}</span>;
}

function EnrolPanel({ data }: { data: CourseOverview }) {
  const qc = useQueryClient();
  const [key, setKey] = useState("");
  const course = data.course;
  // Returning from Stripe: the webhook may land a few seconds after the redirect, so poll briefly.
  const [confirming, setConfirming] = useState(() => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("payment") === "success");
  useEffect(() => {
    if (!confirming) return;
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started > 30_000) {
        clearInterval(timer);
        setConfirming(false);
        return;
      }
      void qc.invalidateQueries({ queryKey: courseKey(course.id) });
    }, 2000);
    return () => clearInterval(timer);
  }, [confirming, qc, course.id]);
  const price = formatPrice(course.priceCents, course.currency);
  const enrol = useMutation({
    mutationFn: () => api(`/courses/${course.id}/enrol`, { body: { key: key || undefined } }),
    onSuccess: () => {
      toast.success("You're enrolled!");
      void qc.invalidateQueries({ queryKey: courseKey(course.id) });
      void qc.invalidateQueries({ queryKey: ["courses"] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>About this course</CardTitle>
        {course.startDate && <CardDescription>Starts {new Date(course.startDate).toLocaleDateString()}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-4">
        <HtmlContent html={course.summary} />
        {confirming ? (
          <p className="text-sm text-muted-foreground" role="status">
            Confirming your payment… this page will update automatically.
          </p>
        ) : price ? (
          <Button render={<Link href={`/courses/${course.id}/checkout`} />}>Buy for {price}</Button>
        ) : course.selfEnrol === "closed" ? (
          <p className="text-sm text-muted-foreground">Enrolment is managed by your teacher or administrator.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {course.selfEnrol === "key" && (
              <Input className="max-w-xs" type="password" placeholder="Enrolment key" value={key} onChange={(e) => setKey(e.target.value)} aria-label="Enrolment key" />
            )}
            <Button onClick={() => enrol.mutate()} disabled={enrol.isPending}>
              Enrol me
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SectionCard({ section, data, editing, index, total }: { section: Section; data: CourseOverview; editing: boolean; index: number; total: number }) {
  const qc = useQueryClient();
  const courseId = data.course.id;
  const refresh = () => qc.invalidateQueries({ queryKey: courseKey(courseId) });
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(section.title);

  const run = (fn: () => Promise<unknown>, success?: string) =>
    fn()
      .then(() => {
        if (success) toast.success(success);
        return refresh();
      })
      .catch((e) => toast.error(errorMessage(e)));

  const moveActivity = (from: number, to: number) => {
    const ids = section.activities.map((a) => a.id);
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved!);
    void run(() => api(`/courses/${courseId}/sections/${section.id}/activities/order`, { method: "PUT", body: { activityIds: ids } }));
  };
  const moveSection = (to: number) => {
    const ids = data.sections.map((s) => s.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(to, 0, moved!);
    void run(() => api(`/courses/${courseId}/sections/order`, { method: "PUT", body: { sectionIds: ids } }));
  };

  return (
    <Card className={!section.visible ? "opacity-70" : undefined}>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          {renaming ? (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void run(() => api(`/courses/${courseId}/sections/${section.id}`, { method: "PATCH", body: { title } })).then(() => setRenaming(false));
              }}
            >
              <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus aria-label="Section title" />
              <Button type="submit" size="sm">
                Save
              </Button>
            </form>
          ) : (
            <CardTitle className="flex items-center gap-2">
              {section.title}
              {!section.visible && <EyeOff className="size-4 text-muted-foreground" aria-label="Hidden" />}
            </CardTitle>
          )}
          <HtmlContent html={section.summary} className="mt-2 text-muted-foreground" />
        </div>
        {editing && (
          <div className="flex shrink-0 items-center gap-1">
            <Button variant="ghost" size="icon-sm" aria-label="Move section up" disabled={index === 0} onClick={() => moveSection(index - 1)}>
              <ArrowUp />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="Move section down" disabled={index === total - 1} onClick={() => moveSection(index + 1)}>
              <ArrowDown />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="Rename section" onClick={() => setRenaming(!renaming)}>
              <Pencil />
            </Button>
            <Switch
              aria-label="Section visible"
              checked={section.visible}
              onCheckedChange={(visible) => void run(() => api(`/courses/${courseId}/sections/${section.id}`, { method: "PATCH", body: { visible } }))}
            />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Delete section"
              onClick={() => {
                if (confirm(`Delete "${section.title}" and all its activities?`)) {
                  void run(() => api(`/courses/${courseId}/sections/${section.id}`, { method: "DELETE" }), "Section deleted");
                }
              }}
            >
              <Trash2 />
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent>
        {section.activities.length === 0 && !editing && <p className="text-sm text-muted-foreground">No activities yet.</p>}
        <ul className="divide-y">
          {section.activities.map((a, i) => {
            const ui = activityRegistry[a.type];
            const Icon = ui.icon;
            return (
              <li key={a.id} className="flex items-center gap-3 py-2.5">
                <Icon className="size-5 shrink-0 text-primary" />
                <div className="min-w-0 flex-1">
                  <Link href={`/activities/${a.id}`} className="font-medium hover:underline">
                    {a.name}
                  </Link>
                  <div className="flex flex-wrap gap-1.5 text-xs text-muted-foreground">
                    <span>{ui.label}</span>
                    {!a.visible && <Badge variant="outline">Hidden</Badge>}
                    {a.availableUntil && <span>· until {new Date(a.availableUntil).toLocaleString()}</span>}
                  </div>
                </div>
                {editing ? (
                  <div className="flex items-center gap-1">
                    <Button variant="ghost" size="icon-sm" aria-label="Move up" disabled={i === 0} onClick={() => moveActivity(i, i - 1)}>
                      <ArrowUp />
                    </Button>
                    <Button variant="ghost" size="icon-sm" aria-label="Move down" disabled={i === section.activities.length - 1} onClick={() => moveActivity(i, i + 1)}>
                      <ArrowDown />
                    </Button>
                    <Button variant="ghost" size="icon-sm" aria-label="Edit activity" render={<Link href={`/activities/${a.id}/edit`} />}>
                      <Pencil />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Delete activity"
                      onClick={() => {
                        if (confirm(`Delete "${a.name}"? All submissions and grades for it will be removed.`)) {
                          void run(() => api(`/activities/${a.id}`, { method: "DELETE" }), "Activity deleted");
                        }
                      }}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                ) : (
                  <CompletionIcon
                    activity={a}
                    onToggle={() => void run(() => api(`/completion/activities/${a.id}/manual`, { body: { completed: a.completion !== "complete" } }))}
                  />
                )}
              </li>
            );
          })}
        </ul>
        {editing && (
          <Button variant="outline" size="sm" className="mt-3" render={<Link href={`/courses/${courseId}/activities/new?sectionId=${section.id}`} />}>
            <Plus /> Add activity
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

export default function CoursePage() {
  const { data, can } = useCourse();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  if (!data) return null;
  if (!data.capabilities["course:view"]) return <EnrolPanel data={data} />;

  const canEdit = can("course:update");
  return (
    <div className="space-y-4">
      {canEdit && (
        <div className="flex flex-wrap items-center justify-end gap-3">
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={editing} onCheckedChange={setEditing} /> Edit mode
          </label>
          {editing && (
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                try {
                  await api(`/courses/${data.course.id}/sections`, { body: { title: `Section ${data.sections.length}` } });
                  await qc.invalidateQueries({ queryKey: courseKey(data.course.id) });
                } catch (e) {
                  toast.error(errorMessage(e));
                }
              }}
            >
              <Plus /> Add section
            </Button>
          )}
        </div>
      )}
      {data.course.summary && data.sections[0] && <HtmlContent html={data.course.summary} className="text-muted-foreground" />}
      {data.sections.length === 0 ? (
        <EmptyState title="This course has no content yet" />
      ) : (
        data.sections.map((s, i) => <SectionCard key={s.id} section={s} data={data} editing={editing} index={i} total={data.sections.length} />)
      )}
    </div>
  );
}
