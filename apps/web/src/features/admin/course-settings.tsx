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
import { useSession } from "@/lib/session";
import type { Course } from "@/lib/types";
import { ConfirmDialog, Field, formatMoney } from "./shared";

const CURRENCIES = ["USD", "EUR", "GBP", "INR", "AUD", "CAD", "SGD", "JPY", "BRL", "MXN", "ZAR", "AED"];

function PricingCard({ course }: { course: Course }) {
  const qc = useQueryClient();
  const [price, setPrice] = useState(course.priceCents ? (course.priceCents / 100).toFixed(2) : "");
  const [currency, setCurrency] = useState(course.currency ?? "USD");
  const [error, setError] = useState<unknown>(null);
  const save = useMutation({
    mutationFn: () => {
      const trimmed = price.trim();
      const cents = trimmed ? Math.round(Number.parseFloat(trimmed) * 100) : null;
      if (cents !== null && (!Number.isFinite(cents) || cents < 0)) throw new Error("Enter a valid price");
      const cur = currency.trim().toUpperCase();
      if (cents && !/^[A-Z]{3}$/.test(cur)) throw new Error("Currency must be a 3-letter ISO code");
      return api<Course>(`/courses/${course.id}`, { method: "PATCH", body: { priceCents: cents || null, currency: cents ? cur : null } });
    },
    onSuccess: (c) => {
      toast.success(c.priceCents ? `Price set to ${formatMoney(c.priceCents, c.currency ?? "USD")}` : "Course is now free");
      void qc.invalidateQueries({ queryKey: courseKey(course.id) });
      void qc.invalidateQueries({ queryKey: ["courses"] });
    },
    onError: setError,
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Pricing</CardTitle>
        <CardDescription>
          Paid courses are bought at checkout and learners are enrolled automatically after payment. Leave the price blank for a free course. Enable a payment gateway under Administration → Payments.
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
            <Field id="price" label="Price">
              <Input id="price" type="number" inputMode="decimal" min="0" step="0.01" placeholder="Free" value={price} onChange={(e) => setPrice(e.target.value)} />
            </Field>
            <Field id="currency" label="Currency">
              <Input id="currency" list="currency-list" maxLength={3} className="uppercase" value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
              <datalist id="currency-list">
                {CURRENCIES.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </Field>
          </div>
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save pricing"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function DangerZone({ course }: { course: Course }) {
  const qc = useQueryClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const remove = useMutation({
    mutationFn: () => api(`/courses/${course.id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Course deleted");
      qc.removeQueries({ queryKey: courseKey(course.id) });
      void qc.invalidateQueries({ queryKey: ["courses"] });
      router.replace("/courses?mine=1");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle>Delete course</CardTitle>
        <CardDescription>Permanently deletes the course with all its activities, submissions, grades and enrolments. This cannot be undone.</CardDescription>
      </CardHeader>
      <CardContent>
        <Button variant="destructive" onClick={() => setOpen(true)}>
          <Trash2 /> Delete course
        </Button>
      </CardContent>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Delete ${course.fullname}?`}
        description="All course content and learner data will be removed permanently."
        confirmLabel="Delete course"
        destructive
        confirmText={course.shortname}
        pending={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </Card>
  );
}

export function CourseSettings() {
  const course = useCourse();
  const session = useSession();
  const qc = useQueryClient();
  if (!course.data) return null;
  if (!course.can("course:update")) return <EmptyState title="You can't edit this course's settings" />;
  const c = course.data.course;

  const onSubmit = async (values: CourseFormValues) => {
    await api<Course>(`/courses/${c.id}`, { method: "PATCH", body: values });
    toast.success("Course settings saved");
    await qc.invalidateQueries({ queryKey: courseKey(c.id) });
    void qc.invalidateQueries({ queryKey: ["courses"] });
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>General</CardTitle>
        </CardHeader>
        <CardContent>
          <CourseForm key={c.id} initial={c} submitLabel="Save changes" onSubmit={onSubmit} />
        </CardContent>
      </Card>
      {session.can("payment:manage") && <PricingCard key={`${c.id}:${c.priceCents}:${c.currency}`} course={c} />}
      {course.can("course:delete") && <DangerZone course={c} />}
    </div>
  );
}
