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
import type { Course } from "@/lib/types";
import { ConfirmDialog, Field, NativeSelect, RequireCapability, useDebounced } from "./shared";
import type { Cohort, CohortMember } from "./types";
import { UserPicker } from "./user-picker";

const cohortsKey = ["admin", "cohorts"] as const;
export const useCohorts = (enabled = true) => useQuery({ queryKey: cohortsKey, queryFn: () => api<Cohort[]>("/cohorts"), enabled });

function CohortFormDialog({ cohort, open, onOpenChange }: { cohort: Cohort | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [v, setV] = useState({ name: cohort?.name ?? "", idnumber: cohort?.idnumber ?? "", description: cohort?.description ?? "" });
  const [error, setError] = useState<unknown>(null);
  const save = useMutation({
    mutationFn: () => {
      const body = { name: v.name, idnumber: v.idnumber || null, description: v.description || null };
      return cohort ? api(`/cohorts/${cohort.id}`, { method: "PATCH", body }) : api("/cohorts", { body });
    },
    onSuccess: () => {
      toast.success(cohort ? "Cohort updated" : "Cohort created");
      void qc.invalidateQueries({ queryKey: cohortsKey });
      onOpenChange(false);
    },
    onError: setError,
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{cohort ? "Edit cohort" : "New cohort"}</DialogTitle>
          <DialogDescription>Cohorts are site-wide groups of users that can be enrolled into courses together.</DialogDescription>
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
          <Field id="c-name" label="Name">
            <Input id="c-name" required maxLength={255} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
          </Field>
          <Field id="c-idn" label="ID number" hint="Optional identifier from another system.">
            <Input id="c-idn" maxLength={100} value={v.idnumber} onChange={(e) => setV({ ...v, idnumber: e.target.value })} />
          </Field>
          <Field id="c-desc" label="Description">
            <Textarea id="c-desc" rows={3} maxLength={5000} value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function MembersDialog({ cohort, open, onOpenChange }: { cohort: Cohort; open: boolean; onOpenChange: (o: boolean) => void }) {
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
          <DialogTitle>{cohort.name} members</DialogTitle>
        </DialogHeader>
        <UserPicker label="Add members" exclude={members.data?.map((m) => m.id)} onPick={(u) => change.mutate({ add: [u.id] })} />
        <QueryState query={members}>
          {members.data?.length === 0 ? (
            <p className="text-sm text-muted-foreground">No members yet.</p>
          ) : (
            <ul className="max-h-72 divide-y overflow-auto rounded-md border">
              {members.data?.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-2 p-2 text-sm">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{fullName(m)}</div>
                    <div className="truncate text-xs text-muted-foreground">{m.email}</div>
                  </div>
                  <Button variant="ghost" size="icon-sm" aria-label={`Remove ${fullName(m)}`} disabled={change.isPending} onClick={() => change.mutate({ remove: [m.id] })}>
                    <X />
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
      toast.success(`${r.enrolled} new enrolment${r.enrolled === 1 ? "" : "s"}`);
      onDone?.();
      onOpenChange(false);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Enrol cohort</DialogTitle>
          <DialogDescription>Every current member is enrolled as a student. Members already enrolled are left unchanged.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (selectedCohort && selectedCourse) enrol.mutate();
          }}
        >
          {!cohortId && (
            <Field id="ce-cohort" label="Cohort">
              {cohorts.isError ? (
                <ErrorAlert error={cohorts.error} />
              ) : (
                <NativeSelect id="ce-cohort" required value={selectedCohort} onChange={(e) => setSelectedCohort(e.target.value)}>
                  <option value="">Choose a cohort…</option>
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
              <Field id="ce-search" label="Find course">
                <Input id="ce-search" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Course name" />
              </Field>
              <Field id="ce-course" label="Course">
                <NativeSelect id="ce-course" required value={selectedCourse} onChange={(e) => setSelectedCourse(e.target.value)}>
                  <option value="">Choose a course…</option>
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
              Cancel
            </Button>
            <Button type="submit" disabled={!selectedCohort || !selectedCourse || enrol.isPending}>
              {enrol.isPending ? "Enrolling…" : "Enrol"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function CohortsAdmin() {
  const qc = useQueryClient();
  const cohorts = useCohorts();
  const [editing, setEditing] = useState<Cohort | null | "new">(null);
  const [members, setMembers] = useState<Cohort | null>(null);
  const [enrolling, setEnrolling] = useState<Cohort | null>(null);
  const [deleting, setDeleting] = useState<Cohort | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) => api(`/cohorts/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Cohort deleted");
      setDeleting(null);
      void qc.invalidateQueries({ queryKey: cohortsKey });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <RequireCapability capability="cohort:manage">
      <PageHeader
        title="Cohorts"
        description="Site-wide groups of users, e.g. a department or an intake."
        actions={
          <Button onClick={() => setEditing("new")}>
            <Plus /> New cohort
          </Button>
        }
      />
      <QueryState query={cohorts}>
        {cohorts.data?.length === 0 ? (
          <EmptyState title="No cohorts yet" description="Create a cohort to enrol many users into courses at once." />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {cohorts.data?.map((c) => (
              <Card key={c.id}>
                <CardHeader>
                  <CardTitle className="truncate">{c.name}</CardTitle>
                  <CardDescription>
                    {c.memberCount} member{c.memberCount === 1 ? "" : "s"}
                    {c.idnumber && <> · {c.idnumber}</>}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {c.description && <p className="line-clamp-3 text-sm text-muted-foreground">{c.description}</p>}
                  <div className="flex flex-wrap gap-1">
                    <Button size="sm" variant="outline" onClick={() => setMembers(c)}>
                      <Users /> Members
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setEnrolling(c)}>
                      <GraduationCap /> Enrol in course
                    </Button>
                    <Button size="icon-sm" variant="ghost" aria-label={`Edit ${c.name}`} onClick={() => setEditing(c)}>
                      <Pencil />
                    </Button>
                    <Button size="icon-sm" variant="ghost" aria-label={`Delete ${c.name}`} onClick={() => setDeleting(c)}>
                      <Trash2 />
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
        title={`Delete ${deleting?.name}?`}
        description="Members keep their accounts and existing enrolments."
        confirmLabel="Delete cohort"
        destructive
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </RequireCapability>
  );
}
