"use client";

import { ChevronLeft, Trash2 } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { EmptyState, PageHeader, QueryState, fullName } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useActivity } from "@/features/activities/use-activity";
import { api, errorMessage } from "@/lib/api";
import { useFormat, useT } from "@/lib/i18n";
import { useQueryClient } from "@tanstack/react-query";
import { selectClass } from "../assignment/form-utils";
import { quizKeys, round, typeLabel, useResults } from "./api";

type Filter = "all" | "needs" | "finished" | "in_progress";

export function QuizResultsPage() {
  const activity = useActivity();
  const activityId = activity.activityId;
  const results = useResults(activityId);
  const qc = useQueryClient();
  const [filter, setFilter] = useState<Filter>("all");
  const t = useT();
  const fmt = useFormat();
  const canGrade = !!activity.data?.capabilities["quiz:grade"];

  const attempts = useMemo(() => {
    const all = results.data?.attempts ?? [];
    if (filter === "needs") return all.filter((a) => a.needsGrading);
    if (filter === "finished") return all.filter((a) => a.status === "finished");
    if (filter === "in_progress") return all.filter((a) => a.status === "in_progress");
    return all;
  }, [results.data, filter]);

  const finished = results.data?.attempts.filter((a) => a.status === "finished" && a.grade != null) ?? [];
  const average = finished.length ? finished.reduce((s, a) => s + (a.grade ?? 0), 0) / finished.length : null;

  return (
    <QueryState query={activity}>
      {activity.data && (
        <div className="space-y-6">
          <div>
            <Link href={`/activities/${activityId}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
              <ChevronLeft aria-hidden className="size-4" /> {activity.data.name}
            </Link>
            <PageHeader
              className="mt-2 mb-0"
              title={t("quiz.results.title", "Quiz results")}
              description={
                results.data
                  ? t("quiz.results.summary", "{attempts} attempts · average {average} / {max} · {awaiting} awaiting grading", {
                      attempts: results.data.attempts.length,
                      average: round(average),
                      max: results.data.gradeMax,
                      awaiting: results.data.attempts.filter((a) => a.needsGrading).length,
                    })
                  : undefined
              }
            />
          </div>
          <QueryState query={results}>
            {results.data && (
              <>
                <Card>
                  <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
                    <CardTitle className="text-base">
                      <h2 id="res-attempts">{t("quiz.results.attempts", "Attempts")}</h2>
                    </CardTitle>
                    <label className="sr-only" htmlFor="res-filter">
                      {t("quiz.results.filter", "Filter attempts")}
                    </label>
                    <select id="res-filter" className={`${selectClass} w-auto`} value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
                      <option value="all">{t("quiz.results.allAttempts", "All attempts")}</option>
                      <option value="needs">{t("quiz.needsGrading", "Needs grading")}</option>
                      <option value="finished">{t("quiz.finished", "Finished")}</option>
                      <option value="in_progress">{t("quiz.inProgress", "In progress")}</option>
                    </select>
                  </CardHeader>
                  <CardContent className="overflow-x-auto">
                    {attempts.length === 0 ? (
                      (
                      <div role="status">
                        <EmptyState title={t("quiz.results.noAttempts", "No attempts")} />
                      </div>
                    )
                    ) : (
                      <Table aria-labelledby="res-attempts">
                        <TableHeader>
                          <TableRow>
                            <TableHead>{t("quiz.student", "Student")}</TableHead>
                            <TableHead>
                              <abbr title={t("quiz.attempt", "Attempt")} className="no-underline">
                                #
                              </abbr>
                            </TableHead>
                            <TableHead>{t("common.status", "Status")}</TableHead>
                            <TableHead className="hidden md:table-cell">{t("quiz.finished", "Finished")}</TableHead>
                            <TableHead>{t("quiz.marksOutOf", "Marks / {max}", { max: round(results.data.totalMarks) })}</TableHead>
                            <TableHead>{t("quiz.gradeOutOf", "Grade / {max}", { max: results.data.gradeMax })}</TableHead>
                            <TableHead>
                              <span className="sr-only">{t("common.actions", "Actions")}</span>
                            </TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {attempts.map((a) => (
                            <TableRow key={a.id}>
                              <TableCell>
                                <div className="font-medium">
                                  {fullName(a.user)}
                                </div>
                                <div className="hidden text-xs text-muted-foreground sm:block">{a.user.email}</div>
                              </TableCell>
                              <TableCell>{a.attempt}</TableCell>
                              <TableCell>
                                {a.status === "in_progress" ? (
                                  <Badge variant="outline">{t("quiz.inProgress", "In progress")}</Badge>
                                ) : a.needsGrading ? (
                                  <Badge variant="secondary">{t("quiz.needsGrading", "Needs grading")}</Badge>
                                ) : (
                                  <Badge>{t("quiz.finished", "Finished")}</Badge>
                                )}
                              </TableCell>
                              <TableCell className="hidden md:table-cell">{fmt.date(a.finishedAt)}</TableCell>
                              <TableCell>{round(a.sumMarks)}</TableCell>
                              <TableCell>{a.needsGrading ? "—" : round(a.grade)}</TableCell>
                              <TableCell className="whitespace-nowrap text-right">
                                <Link
                                  href={`/activities/${activityId}/quiz/attempt/${a.id}`}
                                  className={buttonVariants({ variant: "ghost", size: "sm" })}
                                >
                                  {a.needsGrading && canGrade ? t("quiz.grade", "Grade") : t("quiz.review", "Review")}
                                  <span className="sr-only">
                                    {" "}
                                    {t("quiz.attemptOf", "attempt {number} of {name}", { number: a.attempt, name: fullName(a.user) })}
                                  </span>
                                </Link>
                                {canGrade && (
                                  <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    aria-label={t("quiz.deleteAttemptOf", "Delete attempt {number} of {name}", { number: a.attempt, name: fullName(a.user) })}
                                    onClick={async () => {
                                      if (!window.confirm(t("quiz.deleteAttemptConfirm", "Delete this attempt? The student's grade will be recalculated."))) return;
                                      try {
                                        await api(`/quizzes/${activityId}/attempts/${a.id}`, { method: "DELETE" });
                                        toast.success(t("quiz.attemptDeleted", "Attempt deleted"));
                                        await qc.invalidateQueries({ queryKey: quizKeys.results(activityId) });
                                      } catch (err) {
                                        toast.error(errorMessage(err));
                                      }
                                    }}
                                  >
                                    <Trash2 aria-hidden />
                                  </Button>
                                )}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    )}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">
                      <h2 id="res-stats">{t("quiz.results.stats", "Question statistics")}</h2>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="overflow-x-auto">
                    <Table aria-labelledby="res-stats" aria-describedby="res-facility">
                      <TableHeader>
                        <TableRow>
                          <TableHead>
                            <abbr title={t("quiz.number", "Number")} className="no-underline">
                              #
                            </abbr>
                          </TableHead>
                          <TableHead>{t("quiz.question", "Question")}</TableHead>
                          <TableHead className="hidden sm:table-cell">{t("quiz.type", "Type")}</TableHead>
                          <TableHead>{t("quiz.responses", "Responses")}</TableHead>
                          <TableHead>{t("quiz.avgMark", "Avg mark")}</TableHead>
                          <TableHead>{t("quiz.facility", "Facility")}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {results.data.questions.map((q) => (
                          <TableRow key={q.slotId}>
                            <TableCell>{q.number}</TableCell>
                            <TableCell className="max-w-56 truncate">{q.name}</TableCell>
                            <TableCell className="hidden sm:table-cell">{q.type ? typeLabel(t, q.type) : t("quiz.edit.random", "Random")}</TableCell>
                            <TableCell>
                              {q.responses}
                              {q.needsGrading > 0 && (
                                <span className="ml-1 text-xs text-muted-foreground">
                                  {t("quiz.toGrade", "({count} to grade)", { count: q.needsGrading })}
                                </span>
                              )}
                            </TableCell>
                            <TableCell>
                              {round(q.averageMark)} / {round(q.maxMark)}
                            </TableCell>
                            <TableCell>
                              {q.facility == null ? (
                                "—"
                              ) : (
                                <span className="inline-flex items-center gap-2">
                                  <span className="h-1.5 w-16 overflow-hidden rounded-full bg-muted" aria-hidden>
                                    <span className="block h-full bg-primary" style={{ width: `${Math.round(q.facility * 100)}%` }} />
                                  </span>
                                  {Math.round(q.facility * 100)}%
                                </span>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                    <p id="res-facility" className="mt-2 text-xs text-muted-foreground">
                      {t("quiz.facilityHint", "Facility index: the average score on a question across finished attempts (higher = easier).")}
                    </p>
                  </CardContent>
                </Card>
              </>
            )}
          </QueryState>
        </div>
      )}
    </QueryState>
  );
}
