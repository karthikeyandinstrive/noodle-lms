"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Circle, EyeOff, Search, ShieldCheck, XCircle } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { EmptyState, QueryState, fullName } from "@/components/common";
import { courseKey } from "@/features/courses/use-course";
import { api, errorMessage } from "@/lib/api";
import { useFormat, useT } from "@/lib/i18n";
import { ruleLabel, stateLabel, type CompletionReport, type CompletionState } from "./types";

export function StateIcon({ state, className = "size-5" }: { state: CompletionState; className?: string }) {
  if (state === "complete" || state === "complete_pass") return <CheckCircle2 className={`${className} text-green-600`} aria-hidden />;
  if (state === "complete_fail") return <XCircle className={`${className} text-destructive`} aria-hidden />;
  return <Circle className={`${className} text-muted-foreground`} aria-hidden />;
}

function OverrideCell({
  courseId,
  activity,
  user,
  state,
  overridden,
}: {
  courseId: string;
  activity: CompletionReport["activities"][number];
  user: { id: string; firstName: string; lastName: string };
  state: CompletionState;
  overridden: boolean;
}) {
  const qc = useQueryClient();
  const t = useT();
  const override = useMutation({
    mutationFn: (next: CompletionState) => api(`/completion/activities/${activity.id}/users/${user.id}/override`, { body: { state: next } }),
    onSuccess: () => {
      toast.success(t("completion.updated", "Completion updated"));
      void qc.invalidateQueries({ queryKey: ["completion", courseId] });
      void qc.invalidateQueries({ queryKey: courseKey(courseId) });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const states: CompletionState[] = activity.completionRule === "pass" ? ["incomplete", "complete_pass", "complete_fail"] : ["incomplete", "complete"];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={
              overridden
                ? t("completion.cellLabelOverridden", "{user}, {activity}: {state} (overridden). Change", { user: fullName(user), activity: activity.name, state: stateLabel(t, state) })
                : t("completion.cellLabel", "{user}, {activity}: {state}. Change", { user: fullName(user), activity: activity.name, state: stateLabel(t, state) })
            }
            disabled={override.isPending}
            className="relative"
          />
        }
      >
        <StateIcon state={state} />
        {overridden && <span className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-amber-500" aria-hidden />}
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {/* GroupLabel must live inside a (radio) group in Base UI. */}
        <DropdownMenuRadioGroup value={state} onValueChange={(v) => v !== state && override.mutate(v as CompletionState)}>
          <DropdownMenuLabel>{t("completion.override", "Override completion")}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {states.map((s) => (
            <DropdownMenuRadioItem key={s} value={s}>
              {stateLabel(t, s)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function CompletionMatrix({ courseId }: { courseId: string }) {
  const t = useT();
  const fmt = useFormat();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const query = useQuery({
    queryKey: ["completion", courseId, "report", { page, search }],
    queryFn: () => api<CompletionReport>(`/completion/courses/${courseId}`, { query: { page, pageSize: 25, search } }),
    placeholderData: keepPreviousData,
  });
  const data = query.data;
  const pages = data ? Math.max(1, Math.ceil(data.users.total / data.users.pageSize)) : 1;
  const stateOf = new Map((data?.states ?? []).map((s) => [`${s.activityId}:${s.userId}`, s]));

  return (
    <div className="space-y-4">
      <div className="relative w-full max-w-sm">
        <Search className="absolute top-2 left-2.5 size-4 text-muted-foreground" aria-hidden />
        <Input
          className="pl-8"
          type="search"
          placeholder={t("completion.searchLearners", "Search learners")}
          aria-label={t("completion.searchLearners", "Search learners")}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
      </div>
      <QueryState query={query}>
        {data &&
          (!data.course.enableCompletion ? (
            <EmptyState
              title={t("completion.trackingOff", "Completion tracking is off")}
              description={t("completion.trackingOffHint", "Enable completion tracking in the course settings to use this report.")}
            />
          ) : !data.activities.length ? (
            <EmptyState
              title={t("completion.noTrackedActivities", "No activities track completion")}
              description={t("completion.noTrackedActivitiesHint", "Set a completion rule on activities to follow learners' progress here.")}
            />
          ) : (
            <>
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full border-collapse text-sm">
                  <caption className="sr-only">{t("completion.caption", "Activity completion: learners in rows, activities in columns")}</caption>
                  <thead className="bg-muted/50">
                    <tr>
                      <th scope="col" className="sticky left-0 z-10 min-w-44 bg-muted px-3 py-2 text-left font-medium">
                        {t("completion.learner", "Learner")}
                      </th>
                      {data.activities.map((a) => (
                        <th key={a.id} scope="col" className="min-w-20 px-2 py-2 align-bottom font-medium">
                          <Link href={`/activities/${a.id}`} className="line-clamp-3 block max-w-32 text-xs hover:underline" title={a.name}>
                            {a.name}
                          </Link>
                          <span className="mt-0.5 flex items-center justify-center gap-1 text-[11px] font-normal text-muted-foreground">
                            {!a.visible && (
                              <>
                                <EyeOff className="size-3" aria-hidden />
                                <span className="sr-only">{t("common.hidden", "Hidden")},</span>
                              </>
                            )}
                            {ruleLabel(t, a.completionRule)}
                          </span>
                        </th>
                      ))}
                      <th scope="col" className="px-3 py-2 text-left font-medium">
                        {t("completion.courseColumn", "Course")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.users.items.map((u) => (
                      <tr key={u.id} className="border-t">
                        <th scope="row" className="sticky left-0 z-10 bg-background px-3 py-1.5 text-left font-normal">
                          <div className="font-medium">{fullName(u)}</div>
                          <div className="text-xs text-muted-foreground">{t("completion.percentComplete", "{percent}% complete", { percent: u.progress })}</div>
                        </th>
                        {data.activities.map((a) => {
                          const s = stateOf.get(`${a.id}:${u.id}`);
                          const state = s?.state ?? "incomplete";
                          return (
                            <td key={a.id} className="px-2 py-1 text-center">
                              {data.canOverride ? (
                                <OverrideCell courseId={courseId} activity={a} user={u} state={state} overridden={!!s?.overridden} />
                              ) : (
                                <span className="inline-flex" title={stateLabel(t, state)}>
                                  <StateIcon state={state} />
                                  <span className="sr-only">{stateLabel(t, state)}</span>
                                </span>
                              )}
                            </td>
                          );
                        })}
                        <td className="px-3 py-1.5 whitespace-nowrap">
                          {u.completedAt ? (
                            <Badge className="bg-green-600 text-white" title={fmt.date(u.completedAt)}>
                              {t("completion.state.complete", "Completed")}
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground">{t("completion.inProgress", "In progress")}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {data.canOverride && (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <ShieldCheck className="size-3.5" aria-hidden />{" "}
                  {t("completion.overrideHint", "Select a cell to override a learner's completion. An amber dot marks overridden states; automatic rules no longer change them.")}
                </p>
              )}
              {pages > 1 && (
                <div className="flex items-center justify-center gap-2">
                  <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                    {t("common.previous", "Previous")}
                  </Button>
                  <span className="text-sm text-muted-foreground" aria-live="polite">
                    {t("catalog.pageOf", "Page {page} of {pages}", { page, pages })}
                  </span>
                  <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>
                    {t("common.next", "Next")}
                  </Button>
                </div>
              )}
            </>
          ))}
      </QueryState>
    </div>
  );
}
