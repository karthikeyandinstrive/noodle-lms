"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, CheckCircle2, Circle, EyeOff, Pencil, Plus, Trash2, XCircle } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { EmptyState, HtmlContent } from "@/components/common";
import { RichTextEditor } from "@/components/rich-text-editor";
import { activityRegistry, activityTypeLabel } from "@/features/activities/registry";
import { formatPrice } from "@/features/courses/course-list";
import { courseKey, useCourse } from "@/features/courses/use-course";
import { api, errorMessage } from "@/lib/api";
import { useFormat, useLocale, useT } from "@/lib/i18n";
import type { ActivitySummary, CourseOverview, Section } from "@/lib/types";
import { cn } from "@/lib/utils";

function CompletionIcon({ activity, onToggle }: { activity: ActivitySummary; onToggle?: () => void }) {
  const t = useT();
  if (activity.completion === null) return null;
  const done = activity.completion === "complete" || activity.completion === "complete_pass";
  const failed = activity.completion === "complete_fail";
  const icon = done ? (
    <CheckCircle2 aria-hidden className="size-5 text-green-600" />
  ) : failed ? (
    <XCircle aria-hidden className="size-5 text-destructive" />
  ) : (
    <Circle aria-hidden className="size-5 text-muted-foreground" />
  );
  const label = done ? t("completion.state.complete", "Completed") : failed ? t("completion.state.notPassed", "Completed (not passed)") : t("completion.state.incomplete", "Not completed");
  if (activity.completionRule === "manual" && onToggle) {
    const action = done ? t("completion.markIncomplete", "Mark as not completed") : t("completion.markComplete", "Mark as completed");
    return (
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={done}
        title={`${label} — ${action}`}
        className="rounded-full focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {icon}
        <span className="sr-only">{t("completion.toggleLabel", "{name}: completed", { name: activity.name })}</span>
      </button>
    );
  }
  return (
    <span title={label} className="inline-flex">
      {icon}
      <span className="sr-only">{label}</span>
    </span>
  );
}

function EnrolPanel({ data }: { data: CourseOverview }) {
  const qc = useQueryClient();
  const t = useT();
  const fmt = useFormat();
  const locale = useLocale();
  const [key, setKey] = useState("");
  const course = data.course;
  // Returning from Stripe: the webhook may land a few seconds after the redirect, so poll briefly.
  const fromCheckout = useSearchParams().get("payment") === "success";
  const [timedOut, setTimedOut] = useState(false);
  const confirming = fromCheckout && !timedOut;
  useEffect(() => {
    if (!confirming) return;
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started > 30_000) {
        clearInterval(timer);
        setTimedOut(true);
        return;
      }
      void qc.invalidateQueries({ queryKey: courseKey(course.id) });
    }, 2000);
    return () => clearInterval(timer);
  }, [confirming, qc, course.id]);
  const price = formatPrice(course.priceCents, course.currency, locale);
  const enrol = useMutation({
    mutationFn: () => api(`/courses/${course.id}/enrol`, { body: { key: key || undefined } }),
    onSuccess: () => {
      toast.success(t("course.enrolled", "You're enrolled!"));
      void qc.invalidateQueries({ queryKey: courseKey(course.id) });
      void qc.invalidateQueries({ queryKey: ["courses"] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>{t("course.about", "About this course")}</CardTitle>
        {course.startDate && <CardDescription>{t("course.starts", "Starts {date}", { date: fmt.date(course.startDate, false) })}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-4">
        <HtmlContent html={course.summary} />
        {confirming ? (
          <p className="text-sm text-muted-foreground" role="status">
            {t("course.confirmingPayment", "Confirming your payment… this page will update automatically.")}
          </p>
        ) : price ? (
          <Link href={`/courses/${course.id}/checkout`} className={buttonVariants()}>
            {t("course.buyFor", "Buy for {price}", { price })}
          </Link>
        ) : course.selfEnrol === "closed" ? (
          <p className="text-sm text-muted-foreground">{t("course.enrolmentManaged", "Enrolment is managed by your teacher or administrator.")}</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {course.selfEnrol === "key" && (
              <Input className="max-w-xs" type="password" placeholder={t("course.enrolmentKey", "Enrolment key")} value={key} onChange={(e) => setKey(e.target.value)} aria-label={t("course.enrolmentKey", "Enrolment key")} />
            )}
            <Button onClick={() => enrol.mutate()} disabled={enrol.isPending}>
              {t("course.enrolMe", "Enrol me")}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SectionCard({ section, data, editing, index, total }: { section: Section; data: CourseOverview; editing: boolean; index: number; total: number }) {
  const qc = useQueryClient();
  const t = useT();
  const fmt = useFormat();
  const courseId = data.course.id;
  const refresh = () => qc.invalidateQueries({ queryKey: courseKey(courseId) });
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(section.title);
  const [summary, setSummary] = useState(section.summary ?? "");
  const formId = useId();

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
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                void run(() => api(`/courses/${courseId}/sections/${section.id}`, { method: "PATCH", body: { title, summary: summary || null } })).then(() => setRenaming(false));
              }}
            >
              <div className="space-y-1.5">
                <Label htmlFor={`${formId}-title`}>{t("course.section.title", "Section title")}</Label>
                <Input id={`${formId}-title`} required value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${formId}-summary`}>{t("course.section.summary", "Section summary")}</Label>
                <RichTextEditor id={`${formId}-summary`} value={summary} onChange={setSummary} minHeight={80} />
              </div>
              <div className="flex gap-2">
                <Button type="submit" size="sm">
                  {t("common.save", "Save")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setTitle(section.title);
                    setSummary(section.summary ?? "");
                    setRenaming(false);
                  }}
                >
                  {t("common.cancel", "Cancel")}
                </Button>
              </div>
            </form>
          ) : (
            <>
              <CardTitle className="flex items-center gap-2">
                {section.title}
                {!section.visible && (
                  <>
                    <EyeOff className="size-4 text-muted-foreground" aria-hidden />
                    <span className="sr-only">({t("common.hidden", "Hidden")})</span>
                  </>
                )}
              </CardTitle>
              <HtmlContent html={section.summary} className="mt-2 text-muted-foreground" />
            </>
          )}
        </div>
        {editing && (
          <div className="flex shrink-0 items-center gap-1">
            <Button variant="ghost" size="icon-sm" aria-label={t("course.section.moveUp", "Move section up")} disabled={index === 0} onClick={() => moveSection(index - 1)}>
              <ArrowUp aria-hidden />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label={t("course.section.moveDown", "Move section down")} disabled={index === total - 1} onClick={() => moveSection(index + 1)}>
              <ArrowDown aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("course.section.edit", "Edit section title and summary")}
              aria-expanded={renaming}
              onClick={() => {
                if (!renaming) {
                  setTitle(section.title);
                  setSummary(section.summary ?? "");
                }
                setRenaming(!renaming);
              }}
            >
              <Pencil aria-hidden />
            </Button>
            <Switch
              aria-label={t("course.section.visible", "Section visible")}
              checked={section.visible}
              onCheckedChange={(visible) => void run(() => api(`/courses/${courseId}/sections/${section.id}`, { method: "PATCH", body: { visible } }))}
            />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("course.section.delete", "Delete section")}
              onClick={() => {
                if (confirm(t("course.section.confirmDelete", "Delete \"{name}\" and all its activities?", { name: section.title }))) {
                  void run(() => api(`/courses/${courseId}/sections/${section.id}`, { method: "DELETE" }), t("course.section.deleted", "Section deleted"));
                }
              }}
            >
              <Trash2 aria-hidden />
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent>
        {section.activities.length === 0 && !editing && <p className="text-sm text-muted-foreground">{t("course.noActivities", "No activities yet.")}</p>}
        <ul className="divide-y">
          {section.activities.map((a, i) => {
            const ui = activityRegistry[a.type];
            const Icon = ui.icon;
            return (
              <li key={a.id} className="flex items-center gap-3 py-2.5">
                <Icon aria-hidden className="size-5 shrink-0 text-primary" />
                <div className="min-w-0 flex-1">
                  <Link href={`/activities/${a.id}`} className="font-medium hover:underline">
                    {a.name}
                  </Link>
                  <div className="flex flex-wrap gap-1.5 text-xs text-muted-foreground">
                    <span>{activityTypeLabel(t, a.type)}</span>
                    {!a.visible && <Badge variant="outline">{t("common.hidden", "Hidden")}</Badge>}
                    {a.availableUntil && <span>· {t("activity.until", "until {date}", { date: fmt.date(a.availableUntil) })}</span>}
                  </div>
                </div>
                {editing ? (
                  <div className="flex items-center gap-1">
                    <Button variant="ghost" size="icon-sm" aria-label={t("course.activity.moveUp", "Move {name} up", { name: a.name })} disabled={i === 0} onClick={() => moveActivity(i, i - 1)}>
                      <ArrowUp aria-hidden />
                    </Button>
                    <Button variant="ghost" size="icon-sm" aria-label={t("course.activity.moveDown", "Move {name} down", { name: a.name })} disabled={i === section.activities.length - 1} onClick={() => moveActivity(i, i + 1)}>
                      <ArrowDown aria-hidden />
                    </Button>
                    <Link href={`/activities/${a.id}/edit`} aria-label={t("course.activity.edit", "Edit {name}", { name: a.name })} className={buttonVariants({ variant: "ghost", size: "icon-sm" })}>
                      <Pencil aria-hidden />
                    </Link>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("course.activity.delete", "Delete {name}", { name: a.name })}
                      onClick={() => {
                        if (confirm(t("course.activity.confirmDelete", "Delete \"{name}\"? All submissions and grades for it will be removed.", { name: a.name }))) {
                          void run(() => api(`/activities/${a.id}`, { method: "DELETE" }), t("course.activity.deleted", "Activity deleted"));
                        }
                      }}
                    >
                      <Trash2 aria-hidden />
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
          <Link href={`/courses/${courseId}/activities/new?sectionId=${section.id}`} className={cn(buttonVariants({ variant: "outline", size: "sm" }), "mt-3")}>
            <Plus aria-hidden /> {t("course.addActivity", "Add activity")}
          </Link>
        )}
      </CardContent>
    </Card>
  );
}

export default function CoursePage() {
  const { data, can } = useCourse();
  const qc = useQueryClient();
  const t = useT();
  const [editing, setEditing] = useState(false);
  if (!data) return null;
  if (!data.capabilities["course:view"])
    return (
      <Suspense>
        <EnrolPanel data={data} />
      </Suspense>
    );

  const canEdit = can("course:update");
  return (
    <div className="space-y-4">
      {canEdit && (
        <div className="flex flex-wrap items-center justify-end gap-3">
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={editing} onCheckedChange={setEditing} /> {t("course.editMode", "Edit mode")}
          </label>
          {editing && (
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                try {
                  await api(`/courses/${data.course.id}/sections`, { body: { title: t("course.section.defaultTitle", "Section {number}", { number: data.sections.length }) } });
                  await qc.invalidateQueries({ queryKey: courseKey(data.course.id) });
                } catch (e) {
                  toast.error(errorMessage(e));
                }
              }}
            >
              <Plus aria-hidden /> {t("course.addSection", "Add section")}
            </Button>
          )}
        </div>
      )}
      {data.course.summary && data.sections[0] && <HtmlContent html={data.course.summary} className="text-muted-foreground" />}
      {data.sections.length === 0 ? (
        <EmptyState title={t("course.noContent", "This course has no content yet")} />
      ) : (
        data.sections.map((s, i) => <SectionCard key={s.id} section={s} data={data} editing={editing} index={i} total={data.sections.length} />)
      )}
    </div>
  );
}
