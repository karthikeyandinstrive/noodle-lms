"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GraduationCap, Pencil, Plus, Trash2, Users, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState, ErrorAlert, PageHeader, QueryState, fullName } from "@/components/common";
import { api, errorMessage, type Paged } from "@/lib/api";
import { useT } from "@/lib/i18n";
import type { Course } from "@/lib/types";
import { ConfirmDialog, Field, NativeSelect, RequireCapability, useDebounced } from "./shared";
import type { Cohort, CohortMember } from "./types";
import { UserPicker } from "./user-picker";

const cohortsKey = ["admin", "cohorts"] as const;
export const useCohorts = (enabled = true) => useQuery({ queryKey: cohortsKey, queryFn: () => api<Cohort[]>("/cohorts"), enabled });

function CohortFormDialog({ cohort, open, onOpenChange }: { cohort: Cohort | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [v, setV] = useState({ name: cohort?.name ?? "", idnumber: cohort?.idnumber ?? "", description: cohort?.description ?? "" });
  const [error, setError] = useState<unknown>(null);
  const save = useMutation({
    mutationFn: () => {
      const body = { name: v.name, idnumber: v.idnumber || null, description: v.description || null };
      return cohort ? api(`/cohorts/${cohort.id}`, { method: "PATCH", body }) : api("/cohorts", { body });
    },
    onSuccess: () => {
      toast.success(cohort ? t("admin.cohorts.updated", "Cohort updated") : t("admin.cohorts.created", "Cohort created"));
      void qc.invalidateQueries({ queryKey: cohortsKey });
      onOpenChange(false);
    },
    onError: setError,
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{cohort ? t("admin.cohorts.editCohort", "Edit cohort") : t("admin.cohorts.newCohort", "New cohort")}</DialogTitle>
          <DialogDescription>{t("admin.cohorts.formHelp", "Cohorts are site-wide groups of users that can be enrolled into courses together.")}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            save.mutate();
          }}
        >
          {error ? <ErrorAlert error={error} /> : null}
          <Field id="c-name" label={t("common.name", "Name")}>
            <Input id="c-name" required maxLength={255} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
          </Field>
          <Field id="c-idn" label={t("admin.cohorts.idnumber", "ID number")} hint={t("admin.cohorts.idnumberHint", "Optional identifier from another system.")}>
            <Input id="c-idn" maxLength={100} value={v.idnumber} onChange={(e) => setV({ ...v, idnumber: e.target.value })} />
          </Field>
          <Field id="c-desc" label={t("common.description", "Description")}>
            <Textarea id="c-desc" rows={3} maxLength={5000} value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("common.cancel", "Cancel")}
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? t("common.saving", "Saving…") : t("common.save", "Save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function MembersDialog({ cohort, open, onOpenChange }: { cohort: Cohort; open: boolean; onOpenChange: (o: boolean) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const key = [...cohortsKey, cohort.id, "members"];
  const members = useQuery({ queryKey: key, queryFn: () => api<CohortMember[]>(`/cohorts/${cohort.id}/members`), enabled: open });
  const change = useMutation({
    mutationFn: (body: { add?: string[]; remove?: string[] }) => api(`/cohorts/${cohort.id}/members`, { method: "PUT", body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: key });
      void qc.invalidateQueries({ queryKey: cohortsKey });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("admin.cohorts.membersTitle", "{name} members", { name: cohort.name })}</DialogTitle>
        </DialogHeader>
        <UserPicker label={t("admin.cohorts.addMembers", "Add members")} exclude={members.data?.map((m) => m.id)} onPick={(u) => change.mutate({ add: [u.id] })} />
        <QueryState query={members}>
          {members.data?.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("admin.cohorts.noMembers", "No members yet.")}</p>
          ) : (
            <ul className="max-h-72 divide-y overflow-auto rounded-md border" aria-label={t("admin.cohorts.members", "Members")}>
              {members.data?.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-2 p-2 text-sm">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{fullName(m)}</div>
                    <div className="truncate text-xs text-muted-foreground">{m.email}</div>
                  </div>
                  <Button variant="ghost" size="icon-sm" aria-label={t("admin.shared.removeName", "Remove {name}", { name: fullName(m) })} disabled={change.isPending} onClick={() => change.mutate({ remove: [m.id] })}>
                    <X aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </QueryState>
      </DialogContent>
    </Dialog>
  );
}

/** Enrol all members of a cohort into a course (also used from the course participants page). */
export function CohortEnrolDialog({
  open,
  onOpenChange,
  cohortId,
  courseId,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  cohortId?: string;
  courseId?: string;
  onDone?: () => void;
}) {
  const t = useT();
  const [selectedCohort, setSelectedCohort] = useState(cohortId ?? "");
  const [selectedCourse, setSelectedCourse] = useState(courseId ?? "");
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim());
  const cohorts = useCohorts(open && !cohortId);
  const courses = useQuery({
    queryKey: ["courses", "picker", q],
    queryFn: () => api<Paged<Course>>("/courses", { query: { search: q, pageSize: 20 } }),
    enabled: open && !courseId,
  });
  const enrol = useMutation({
    mutationFn: () => api<{ enrolled: number }>(`/courses/${selectedCourse}/cohort-enrol`, { body: { cohortId: selectedCohort } }),
    onSuccess: (r) => {
      toast.success(r.enrolled === 1 ? t("admin.cohorts.enrolled.one", "1 new enrolment") : t("admin.cohorts.enrolled.other", "{count} new enrolments", { count: r.enrolled }));
      onDone?.();
      onOpenChange(false);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("admin.cohorts.enrolCohort", "Enrol cohort")}</DialogTitle>
          <DialogDescription>{t("admin.cohorts.enrolHelp", "Every current member is enrolled as a student. Members already enrolled are left unchanged.")}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (selectedCohort && selectedCourse) enrol.mutate();
          }}
        >
          {!cohortId && (
            <Field id="ce-cohort" label={t("admin.cohorts.cohort", "Cohort")}>
              {cohorts.isError ? (
                <ErrorAlert error={cohorts.error} />
              ) : (
                <NativeSelect id="ce-cohort" required value={selectedCohort} onChange={(e) => setSelectedCohort(e.target.value)}>
                  <option value="">{t("admin.cohorts.chooseCohort", "Choose a cohort…")}</option>
                  {cohorts.data?.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.memberCount})
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
          )}
          {!courseId && (
            <>
              <Field id="ce-search" label={t("admin.cohorts.findCourse", "Find course")}>
                <Input id="ce-search" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("admin.cohorts.courseName", "Course name")} />
              </Field>
              <Field id="ce-course" label={t("admin.cohorts.course", "Course")}>
                <NativeSelect id="ce-course" required value={selectedCourse} onChange={(e) => setSelectedCourse(e.target.value)}>
                  <option value="">{t("admin.cohorts.chooseCourse", "Choose a course…")}</option>
                  {courses.data?.items.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.fullname}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            </>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("common.cancel", "Cancel")}
            </Button>
            <Button type="submit" disabled={!selectedCohort || !selectedCourse || enrol.isPending}>
              {enrol.isPending ? t("admin.shared.enrolling", "Enrolling…") : t("admin.shared.enrol", "Enrol")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function CohortsAdmin() {
  const t = useT();
  const qc = useQueryClient();
  const cohorts = useCohorts();
  const [editing, setEditing] = useState<Cohort | null | "new">(null);
  const [members, setMembers] = useState<Cohort | null>(null);
  const [enrolling, setEnrolling] = useState<Cohort | null>(null);
  const [deleting, setDeleting] = useState<Cohort | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) => api(`/cohorts/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(t("admin.cohorts.deleted", "Cohort deleted"));
      setDeleting(null);
      void qc.invalidateQueries({ queryKey: cohortsKey });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <RequireCapability capability="cohort:manage">
      <PageHeader
        title={t("admin.cohorts.title", "Cohorts")}
        description={t("admin.cohorts.description", "Site-wide groups of users, e.g. a department or an intake.")}
        actions={
          <Button onClick={() => setEditing("new")}>
            <Plus aria-hidden /> {t("admin.cohorts.newCohort", "New cohort")}
          </Button>
        }
      />
      <QueryState query={cohorts}>
        {cohorts.data?.length === 0 ? (
          <EmptyState title={t("admin.cohorts.empty", "No cohorts yet")} description={t("admin.cohorts.emptyHelp", "Create a cohort to enrol many users into courses at once.")} />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {cohorts.data?.map((c) => (
              <Card key={c.id}>
                <CardHeader>
                  <CardTitle className="truncate">{c.name}</CardTitle>
                  <CardDescription>
                    {c.memberCount === 1 ? t("admin.shared.memberCount.one", "1 member") : t("admin.shared.memberCount.other", "{count} members", { count: c.memberCount })}
                    {c.idnumber && <> · {c.idnumber}</>}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {c.description && <p className="line-clamp-3 text-sm text-muted-foreground">{c.description}</p>}
                  <div className="flex flex-wrap gap-1">
                    <Button size="sm" variant="outline" onClick={() => setMembers(c)}>
                      <Users aria-hidden /> {t("admin.cohorts.members", "Members")}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setEnrolling(c)}>
                      <GraduationCap aria-hidden /> {t("admin.cohorts.enrolInCourse", "Enrol in course")}
                    </Button>
                    <Button size="icon-sm" variant="ghost" aria-label={t("admin.shared.editName", "Edit {name}", { name: c.name })} onClick={() => setEditing(c)}>
                      <Pencil aria-hidden />
                    </Button>
                    <Button size="icon-sm" variant="ghost" aria-label={t("admin.shared.deleteName", "Delete {name}", { name: c.name })} onClick={() => setDeleting(c)}>
                      <Trash2 aria-hidden />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </QueryState>
      {editing && <CohortFormDialog key={editing === "new" ? "new" : editing.id} cohort={editing === "new" ? null : editing} open onOpenChange={(o) => !o && setEditing(null)} />}
      {members && <MembersDialog cohort={members} open onOpenChange={(o) => !o && setMembers(null)} />}
      {enrolling && <CohortEnrolDialog cohortId={enrolling.id} open onOpenChange={(o) => !o && setEnrolling(null)} />}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={t("admin.shared.deleteTitle", "Delete {name}?", { name: deleting?.name ?? "" })}
        description={t("admin.cohorts.deleteDescription", "Members keep their accounts and existing enrolments.")}
        confirmLabel={t("admin.cohorts.deleteCohort", "Delete cohort")}
        destructive
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </RequireCapability>
  );
}
