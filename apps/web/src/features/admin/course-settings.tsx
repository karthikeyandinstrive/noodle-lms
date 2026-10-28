"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { EmptyState, ErrorAlert } from "@/components/common";
import { CourseForm, type CourseFormValues } from "@/features/courses/course-form";
import { courseKey, useCourse } from "@/features/courses/use-course";
import { api, errorMessage } from "@/lib/api";
import { useFormat, useT } from "@/lib/i18n";
import { useSession } from "@/lib/session";
import type { Course } from "@/lib/types";
import { ConfirmDialog, Field } from "./shared";

const CURRENCIES = ["USD", "EUR", "GBP", "INR", "AUD", "CAD", "SGD", "JPY", "BRL", "MXN", "ZAR", "AED"];

function PricingCard({ course }: { course: Course }) {
  const t = useT();
  const fmt = useFormat();
  const qc = useQueryClient();
  const [price, setPrice] = useState(course.priceCents ? (course.priceCents / 100).toFixed(2) : "");
  const [currency, setCurrency] = useState(course.currency ?? "USD");
  const [error, setError] = useState<unknown>(null);
  const money = (cents: number, cur: string) => {
    try {
      return fmt.number(cents / 100, { style: "currency", currency: cur });
    } catch {
      return `${(cents / 100).toFixed(2)} ${cur}`;
    }
  };
  const save = useMutation({
    mutationFn: () => {
      const trimmed = price.trim();
      const cents = trimmed ? Math.round(Number.parseFloat(trimmed) * 100) : null;
      if (cents !== null && (!Number.isFinite(cents) || cents < 0)) throw new Error(t("admin.courseSettings.invalidPrice", "Enter a valid price"));
      const cur = currency.trim().toUpperCase();
      if (cents && !/^[A-Z]{3}$/.test(cur)) throw new Error(t("admin.courseSettings.invalidCurrency", "Currency must be a 3-letter ISO code"));
      return api<Course>(`/courses/${course.id}`, { method: "PATCH", body: { priceCents: cents || null, currency: cents ? cur : null } });
    },
    onSuccess: (c) => {
      toast.success(
        c.priceCents
          ? t("admin.courseSettings.priceSet", "Price set to {price}", { price: money(c.priceCents, c.currency ?? "USD") })
          : t("admin.courseSettings.nowFree", "Course is now free"),
      );
      void qc.invalidateQueries({ queryKey: courseKey(course.id) });
      void qc.invalidateQueries({ queryKey: ["courses"] });
    },
    onError: setError,
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("admin.courseSettings.pricing", "Pricing")}</CardTitle>
        <CardDescription>
          {t(
            "admin.courseSettings.pricingHelp",
            "Paid courses are bought at checkout and learners are enrolled automatically after payment. Leave the price blank for a free course. Enable a payment gateway under Administration → Payments.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            save.mutate();
          }}
        >
          {error ? <ErrorAlert error={error} /> : null}
          <div className="grid max-w-md gap-3 sm:grid-cols-[1fr_8rem]">
            <Field id="price" label={t("admin.courseSettings.price", "Price")}>
              <Input id="price" type="number" inputMode="decimal" min="0" step="0.01" placeholder={t("admin.courseSettings.free", "Free")} value={price} onChange={(e) => setPrice(e.target.value)} />
            </Field>
            <Field id="currency" label={t("admin.courseSettings.currency", "Currency")}>
              <Input id="currency" list="currency-list" maxLength={3} className="uppercase" value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
              <datalist id="currency-list">
                {CURRENCIES.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </Field>
          </div>
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? t("common.saving", "Saving…") : t("admin.courseSettings.savePricing", "Save pricing")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function DangerZone({ course }: { course: Course }) {
  const t = useT();
  const qc = useQueryClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const remove = useMutation({
    mutationFn: () => api(`/courses/${course.id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(t("admin.courseSettings.deleted", "Course deleted"));
      qc.removeQueries({ queryKey: courseKey(course.id) });
      void qc.invalidateQueries({ queryKey: ["courses"] });
      router.replace("/courses?mine=1");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle>{t("admin.courseSettings.deleteCourse", "Delete course")}</CardTitle>
        <CardDescription>
          {t("admin.courseSettings.deleteHelp", "Permanently deletes the course with all its activities, submissions, grades and enrolments. This cannot be undone.")}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button variant="destructive" onClick={() => setOpen(true)}>
          <Trash2 aria-hidden /> {t("admin.courseSettings.deleteCourse", "Delete course")}
        </Button>
      </CardContent>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={t("admin.shared.deleteTitle", "Delete {name}?", { name: course.fullname })}
        description={t("admin.courseSettings.deleteDescription", "All course content and learner data will be removed permanently.")}
        confirmLabel={t("admin.courseSettings.deleteCourse", "Delete course")}
        destructive
        confirmText={course.shortname}
        pending={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </Card>
  );
}

export function CourseSettings() {
  const t = useT();
  const course = useCourse();
  const session = useSession();
  const qc = useQueryClient();
  if (!course.data) return null;
  if (!course.can("course:update")) return <EmptyState title={t("admin.courseSettings.cantEdit", "You can't edit this course's settings")} />;
  const c = course.data.course;

  const onSubmit = async (values: CourseFormValues) => {
    await api<Course>(`/courses/${c.id}`, { method: "PATCH", body: values });
    toast.success(t("admin.courseSettings.saved", "Course settings saved"));
    await qc.invalidateQueries({ queryKey: courseKey(c.id) });
    void qc.invalidateQueries({ queryKey: ["courses"] });
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t("admin.shared.general", "General")}</CardTitle>
        </CardHeader>
        <CardContent>
          <CourseForm key={c.id} initial={c} submitLabel={t("admin.shared.saveChanges", "Save changes")} onSubmit={onSubmit} />
        </CardContent>
      </Card>
      {session.can("payment:manage") && <PricingCard key={`${c.id}:${c.priceCents}:${c.currency}`} course={c} />}
      {course.can("course:delete") && <DangerZone course={c} />}
    </div>
  );
}
