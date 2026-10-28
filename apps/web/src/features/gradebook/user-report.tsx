"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, HtmlContent, QueryState } from "@/components/common";
import { api } from "@/lib/api";
import { useLocale, useT } from "@/lib/i18n";
import { fmtGrade, fmtPercent, gradesKey, type UserReport } from "./types";

export function useMyUserReport(courseId: string, enabled = true) {
  return useQuery({
    queryKey: [...gradesKey(courseId), "me"],
    queryFn: () => api<UserReport>(`/grades/courses/${courseId}/me`),
    enabled,
  });
}

/** Learner-facing grade table of one course (hidden items are already removed by the API). */
export function UserReportTable({ report, compact = false }: { report: UserReport; compact?: boolean }) {
  const t = useT();
  const locale = useLocale();
  const categoryName = new Map(report.categories.filter((c) => c.parentId).map((c) => [c.id, c.name]));
  if (!report.items.length && !report.courseTotal) return <EmptyState title={t("grades.noGrades", "No grades yet")} />;
  return (
    <div className="space-y-4">
      {report.courseTotal && (
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg border bg-muted/30 p-4">
          <span className="text-sm text-muted-foreground">{t("grades.courseTotal", "Course total")}</span>
          <span className="text-2xl font-semibold tabular-nums">{fmtPercent(report.courseTotal.percentage, locale)}</span>
          <span className="text-sm text-muted-foreground tabular-nums">
            {fmtGrade(report.courseTotal.grade, locale)} / {fmtGrade(report.courseTotal.gradeMax, locale)}
          </span>
        </div>
      )}
      {/* Cards on small screens, a table from sm up. */}
      <ul className="space-y-2 sm:hidden">
        {report.items.map((i) => (
          <li key={i.id} className="rounded-lg border p-3">
            <div className="flex items-start justify-between gap-2">
              <span className="font-medium">{i.activityId ? <Link href={`/activities/${i.activityId}`} className="hover:underline">{i.name}</Link> : i.name}</span>
              <span className="tabular-nums">
                {fmtGrade(i.grade, locale)} / {fmtGrade(i.gradeMax, locale)}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap gap-1.5 text-xs text-muted-foreground">
              {i.type === "category" && <Badge variant="secondary">{t("grades.categoryTotal", "Category total")}</Badge>}
              {i.categoryId && categoryName.get(i.categoryId) && i.type !== "category" && <span>{categoryName.get(i.categoryId)}</span>}
              <span>{fmtPercent(i.percentage, locale)}</span>
            </div>
            {!compact && i.feedback && <HtmlContent html={i.feedback} className="mt-2 text-sm" />}
          </li>
        ))}
      </ul>
      <div className="hidden overflow-x-auto rounded-lg border sm:block">
        <table className="w-full text-sm">
          <caption className="sr-only">{t("grades.userCaption", "Grades in {course}", { course: report.course.fullname })}</caption>
          <thead className="bg-muted/50 text-left">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">{t("grades.gradeItem", "Grade item")}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{t("grades.grade", "Grade")}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{t("grades.rangeHeader", "Range")}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{t("grades.percentage", "Percentage")}</th>
              {!compact && <th scope="col" className="px-3 py-2 font-medium">{t("grades.feedback", "Feedback")}</th>}
            </tr>
          </thead>
          <tbody>
            {report.items.map((i) => (
              <tr key={i.id} className={i.type === "category" ? "border-t bg-muted/30 font-medium" : "border-t"}>
                <th scope="row" className="px-3 py-2 text-left font-normal">
                  <div className={i.type === "category" ? "font-medium" : undefined}>
                    {i.activityId ? (
                      <Link href={`/activities/${i.activityId}`} className="hover:underline">
                        {i.name}
                      </Link>
                    ) : (
                      i.name
                    )}
                  </div>
                  {i.type !== "category" && i.categoryId && categoryName.get(i.categoryId) && (
                    <div className="text-xs text-muted-foreground">{categoryName.get(i.categoryId)}</div>
                  )}
                </th>
                <td className="px-3 py-2 text-right tabular-nums">
                  {fmtGrade(i.grade, locale)}
                  {i.gradePass !== null && i.grade !== null && (
                    <span className="sr-only">{i.grade >= i.gradePass ? ` (${t("grades.passed", "passed")})` : ` (${t("grades.notPassed", "not passed")})`}</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right text-muted-foreground tabular-nums">
                  {fmtGrade(i.gradeMin, locale)}–{fmtGrade(i.gradeMax, locale)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{fmtPercent(i.percentage, locale)}</td>
                {!compact && <td className="px-3 py-2">{i.feedback ? <HtmlContent html={i.feedback} /> : <span className="text-muted-foreground">–</span>}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function MyCourseGrades({ courseId }: { courseId: string }) {
  const t = useT();
  const report = useMyUserReport(courseId);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("grades.myGrades", "My grades")}</CardTitle>
        <CardDescription>{t("grades.myGradesHint", "Your grades and feedback in this course.")}</CardDescription>
      </CardHeader>
      <CardContent>
        <QueryState query={report}>{report.data && <UserReportTable report={report.data} />}</QueryState>
      </CardContent>
    </Card>
  );
}
