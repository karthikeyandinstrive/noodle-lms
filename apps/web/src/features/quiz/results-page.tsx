"use client";

import { ChevronLeft, Trash2 } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { EmptyState, PageHeader, QueryState, formatDate } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useActivity } from "@/features/activities/use-activity";
import { api, errorMessage } from "@/lib/api";
import { useQueryClient } from "@tanstack/react-query";
import { selectClass } from "../assignment/form-utils";
import { TYPE_LABEL, quizKeys, round, useResults } from "./api";

type Filter = "all" | "needs" | "finished" | "in_progress";

export function QuizResultsPage() {
  const activity = useActivity();
  const activityId = activity.activityId;
  const results = useResults(activityId);
  const qc = useQueryClient();
  const [filter, setFilter] = useState<Filter>("all");
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
              <ChevronLeft className="size-4" /> {activity.data.name}
            </Link>
            <PageHeader
              className="mt-2 mb-0"
              title="Quiz results"
              description={
                results.data
                  ? `${results.data.attempts.length} attempts · average ${round(average)} / ${results.data.gradeMax} · ${results.data.attempts.filter((a) => a.needsGrading).length} awaiting grading`
                  : undefined
              }
            />
          </div>
          <QueryState query={results}>
            {results.data && (
              <>
                <Card>
                  <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
                    <CardTitle className="text-base">Attempts</CardTitle>
                    <label className="sr-only" htmlFor="res-filter">
                      Filter attempts
                    </label>
                    <select id="res-filter" className={`${selectClass} w-auto`} value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
                      <option value="all">All attempts</option>
                      <option value="needs">Needs grading</option>
                      <option value="finished">Finished</option>
                      <option value="in_progress">In progress</option>
                    </select>
                  </CardHeader>
                  <CardContent className="overflow-x-auto">
                    {attempts.length === 0 ? (
                      <EmptyState title="No attempts" />
                    ) : (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Student</TableHead>
                            <TableHead>#</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead className="hidden md:table-cell">Finished</TableHead>
                            <TableHead>Marks / {round(results.data.totalMarks)}</TableHead>
                            <TableHead>Grade / {results.data.gradeMax}</TableHead>
                            <TableHead>
                              <span className="sr-only">Actions</span>
                            </TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {attempts.map((a) => (
                            <TableRow key={a.id}>
                              <TableCell>
                                <div className="font-medium">
                                  {a.user.firstName} {a.user.lastName}
                                </div>
                                <div className="hidden text-xs text-muted-foreground sm:block">{a.user.email}</div>
                              </TableCell>
                              <TableCell>{a.attempt}</TableCell>
                              <TableCell>
                                {a.status === "in_progress" ? (
                                  <Badge variant="outline">In progress</Badge>
                                ) : a.needsGrading ? (
                                  <Badge variant="secondary">Needs grading</Badge>
                                ) : (
                                  <Badge>Finished</Badge>
                                )}
                              </TableCell>
                              <TableCell className="hidden md:table-cell">{formatDate(a.finishedAt)}</TableCell>
                              <TableCell>{round(a.sumMarks)}</TableCell>
                              <TableCell>{a.needsGrading ? "—" : round(a.grade)}</TableCell>
                              <TableCell className="whitespace-nowrap text-right">
                                <Button variant="ghost" size="sm" render={<Link href={`/activities/${activityId}/quiz/attempt/${a.id}`} />}>
                                  {a.needsGrading && canGrade ? "Grade" : "Review"}
                                </Button>
                                {canGrade && (
                                  <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    aria-label={`Delete attempt ${a.attempt} of ${a.user.firstName} ${a.user.lastName}`}
                                    onClick={async () => {
                                      if (!window.confirm("Delete this attempt? The student's grade will be recalculated.")) return;
                                      try {
                                        await api(`/quizzes/${activityId}/attempts/${a.id}`, { method: "DELETE" });
                                        toast.success("Attempt deleted");
                                        await qc.invalidateQueries({ queryKey: quizKeys.results(activityId) });
                                      } catch (err) {
                                        toast.error(errorMessage(err));
                                      }
                                    }}
                                  >
                                    <Trash2 />
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
                    <CardTitle className="text-base">Question statistics</CardTitle>
                  </CardHeader>
                  <CardContent className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>#</TableHead>
                          <TableHead>Question</TableHead>
                          <TableHead className="hidden sm:table-cell">Type</TableHead>
                          <TableHead>Responses</TableHead>
                          <TableHead>Avg mark</TableHead>
                          <TableHead>Facility</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {results.data.questions.map((q) => (
                          <TableRow key={q.slotId}>
                            <TableCell>{q.number}</TableCell>
                            <TableCell className="max-w-56 truncate">{q.name}</TableCell>
                            <TableCell className="hidden sm:table-cell">{TYPE_LABEL[q.type]}</TableCell>
                            <TableCell>
                              {q.responses}
                              {q.needsGrading > 0 && <span className="ml-1 text-xs text-muted-foreground">({q.needsGrading} to grade)</span>}
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
                    <p className="mt-2 text-xs text-muted-foreground">
                      Facility index: the average score on a question across finished attempts (higher = easier).
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
