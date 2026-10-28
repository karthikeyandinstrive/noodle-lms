"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Medal, Pencil, Plus, ShieldOff, Trash2, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { EmptyState, ErrorAlert, formatDate, fullName, QueryState } from "@/components/common";
import { FileInput } from "@/components/file-input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api, errorMessage, type Paged } from "@/lib/api";
import type { Course, CourseOverview } from "@/lib/types";
import { ConfirmButton, NativeSelectClass, StatusBadge } from "../certificate/shared";
import { BadgeImage } from "./badge-image";
import type { BadgeCriteria, Candidate, ManagedBadge, Recipient } from "./types";

const listKey = (courseId: string | null) => ["badges", "manage", courseId ?? "site"] as const;

type Draft = {
  name: string;
  description: string;
  imageFileId: string | null;
  criteria: BadgeCriteria;
  status: "active" | "inactive";
  expiresAfterDays: number | null;
};

function emptyDraft(courseId: string | null): Draft {
  return {
    name: "",
    description: "",
    imageFileId: null,
    criteria: courseId ? { type: "course_completion", courseId } : { type: "manual" },
    status: "active",
    expiresAfterDays: null,
  };
}

function CriteriaFields({ draft, setDraft, course }: { draft: Draft; setDraft: (d: Draft) => void; course?: CourseOverview }) {
  const courses = useQuery({
    queryKey: ["courses", "all-for-badges"],
    queryFn: () => api<Paged<Course>>("/courses", { query: { pageSize: 100 } }),
    enabled: !course && draft.criteria.type === "course_completion",
  });
  const c = draft.criteria;
  const activities = course?.sections.flatMap((s) => s.activities) ?? [];
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="badge-criteria">How is it earned?</Label>
        <select
          id="badge-criteria"
          className={NativeSelectClass}
          value={c.type}
          onChange={(e) => {
            const t = e.target.value as BadgeCriteria["type"];
            setDraft({
              ...draft,
              criteria:
                t === "manual" ? { type: "manual" } : t === "course_completion" ? { type: "course_completion", courseId: course?.course.id ?? "" } : { type: "activities", activityIds: [] },
            });
          }}
        >
          <option value="manual">Awarded manually</option>
          <option value="course_completion">Completing {course ? "this course" : "a course"}</option>
          {course && <option value="activities">Completing selected activities</option>}
        </select>
      </div>
      {c.type === "course_completion" && !course && (
        <div className="space-y-1.5">
          <Label htmlFor="badge-course">Course</Label>
          <QueryState query={courses}>
            <select
              id="badge-course"
              required
              className={NativeSelectClass}
              value={c.courseId}
              onChange={(e) => setDraft({ ...draft, criteria: { type: "course_completion", courseId: e.target.value } })}
            >
              <option value="" disabled>
                Choose a course…
              </option>
              {courses.data?.items.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.fullname}
                </option>
              ))}
            </select>
          </QueryState>
        </div>
      )}
      {c.type === "activities" && (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Required activities</legend>
          {!activities.length && <p className="text-sm text-muted-foreground">This course has no activities yet.</p>}
          <ul className="max-h-56 space-y-1 overflow-y-auto rounded-lg border p-2">
            {activities.map((a) => {
              const checked = c.activityIds.includes(a.id);
              return (
                <li key={a.id}>
                  <label className="flex items-center gap-2 rounded px-1 py-1 text-sm hover:bg-muted">
                    <Checkbox
                      checked={checked}
                      onCheckedChange={(v) =>
                        setDraft({
                          ...draft,
                          criteria: { type: "activities", activityIds: v ? [...c.activityIds, a.id] : c.activityIds.filter((id) => id !== a.id) },
                        })
                      }
                    />
                    <span className="truncate">{a.name}</span>
                    {a.completionRule === "none" && <span className="ml-auto shrink-0 text-xs text-amber-600">no completion tracking</span>}
                  </label>
                </li>
              );
            })}
          </ul>
        </fieldset>
      )}
    </div>
  );
}

function BadgeDialog({
  open,
  onOpenChange,
  courseId,
  course,
  badge,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  courseId: string | null;
  course?: CourseOverview;
  badge?: ManagedBadge;
}) {
  const qc = useQueryClient();
  // The dialog is keyed by the badge being edited, so initial state is derived once per open.
  const [draft, setDraft] = useState<Draft>(() =>
    badge
      ? {
          name: badge.name,
          description: badge.description,
          imageFileId: badge.imageFileId,
          criteria: badge.criteria,
          status: badge.status === "inactive" ? "inactive" : "active",
          expiresAfterDays: badge.expiresAfterDays,
        }
      : emptyDraft(courseId),
  );

  const save = useMutation({
    mutationFn: () => {
      const criteria = draft.criteria.type === "course_completion" && courseId ? { type: "course_completion" as const } : draft.criteria;
      const body = { ...draft, criteria };
      return badge ? api(`/badges/${badge.id}`, { method: "PATCH", body }) : api("/badges", { body: { ...body, courseId } });
    },
    onSuccess: () => {
      toast.success(badge ? "Badge updated" : "Badge created");
      void qc.invalidateQueries({ queryKey: ["badges"] });
      onOpenChange(false);
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{badge ? "Edit badge" : "New badge"}</DialogTitle>
            <DialogDescription>{courseId ? "Course badges are shown to learners of this course." : "Site badges can be awarded to anyone in the organization."}</DialogDescription>
          </DialogHeader>
          {save.error ? <ErrorAlert error={save.error} /> : null}
          <div className="space-y-1.5">
            <Label htmlFor="badge-name">Name</Label>
            <Input id="badge-name" required maxLength={255} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="badge-description">Description</Label>
            <Textarea id="badge-description" required rows={3} maxLength={5000} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label>Image (PNG or JPEG, square works best)</Label>
            <div className="flex items-center gap-3">
              {badge?.imageFileId && draft.imageFileId === badge.imageFileId && <BadgeImage badgeId={badge.id} hasImage className="size-10" />}
              <FileInput value={draft.imageFileId} accept="image/png,image/jpeg" onChange={(id) => setDraft({ ...draft, imageFileId: id })} />
            </div>
          </div>
          <CriteriaFields draft={draft} setDraft={setDraft} course={course} />
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="badge-expiry">Expires after (days)</Label>
              <Input
                id="badge-expiry"
                type="number"
                min={1}
                placeholder="Never"
                value={draft.expiresAfterDays ?? ""}
                onChange={(e) => setDraft({ ...draft, expiresAfterDays: e.target.value === "" ? null : Math.round(Number(e.target.value)) })}
              />
            </div>
            <label className="flex items-center gap-2 self-end text-sm">
              <Switch checked={draft.status === "active"} onCheckedChange={(c) => setDraft({ ...draft, status: c ? "active" : "inactive" })} /> Active
            </label>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? "Saving…" : "Save badge"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function RecipientsDialog({ badge, open, onOpenChange }: { badge: ManagedBadge; open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const debounced = useDebounced(search);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const recipients = useQuery({ queryKey: ["badges", badge.id, "recipients"], queryFn: () => api<Recipient[]>(`/badges/${badge.id}/recipients`), enabled: open });
  const candidates = useQuery({
    queryKey: ["badges", badge.id, "candidates", debounced],
    queryFn: () => api<Candidate[]>(`/badges/${badge.id}/candidates`, { query: { search: debounced } }),
    enabled: open && (!!badge.courseId || debounced.trim().length >= 2),
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["badges"] });
  const award = useMutation({
    mutationFn: () => api<{ awarded: number }>(`/badges/${badge.id}/award`, { body: { userIds: [...picked] } }),
    onSuccess: (r) => {
      toast.success(`Awarded to ${r.awarded} ${r.awarded === 1 ? "person" : "people"}`);
      setPicked(new Set());
      refresh();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{badge.name}: recipients</DialogTitle>
          <DialogDescription>{badge.criteriaText}</DialogDescription>
        </DialogHeader>

        {badge.status === "active" && (
          <section className="space-y-2" aria-labelledby={`award-${badge.id}`}>
            <h3 id={`award-${badge.id}`} className="text-sm font-medium">
              Award manually
            </h3>
            <Input
              placeholder={badge.courseId ? "Filter enrolled users…" : "Search users by name or email (min. 2 characters)…"}
              aria-label="Search users"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {candidates.data && (
              <ul className="max-h-48 space-y-1 overflow-y-auto rounded-lg border p-2">
                {!candidates.data.length && <li className="text-sm text-muted-foreground">No matching users.</li>}
                {candidates.data.map((u) => (
                  <li key={u.id}>
                    <label className="flex items-center gap-2 rounded px-1 py-1 text-sm hover:bg-muted">
                      <Checkbox
                        disabled={u.awarded}
                        checked={u.awarded || picked.has(u.id)}
                        onCheckedChange={(v) =>
                          setPicked((p) => {
                            const n = new Set(p);
                            if (v) n.add(u.id);
                            else n.delete(u.id);
                            return n;
                          })
                        }
                      />
                      <span className="truncate">{fullName(u)}</span>
                      {u.email && <span className="truncate text-xs text-muted-foreground">{u.email}</span>}
                      {u.awarded && <Badge variant="secondary" className="ml-auto">Has badge</Badge>}
                    </label>
                  </li>
                ))}
              </ul>
            )}
            <Button size="sm" disabled={!picked.size || award.isPending} onClick={() => award.mutate()}>
              <Medal /> Award to {picked.size || ""} selected
            </Button>
          </section>
        )}

        <section className="space-y-2">
          <h3 className="text-sm font-medium">Awarded</h3>
          <QueryState query={recipients}>
            {recipients.data && !recipients.data.length && <p className="text-sm text-muted-foreground">Nobody has earned this badge yet.</p>}
            <ul className="divide-y rounded-lg border">
              {recipients.data?.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-2 p-2 text-sm">
                  <span className="font-medium">{fullName(r.user)}</span>
                  <span className="text-muted-foreground">{formatDate(r.issuedAt, false)}</span>
                  <StatusBadge status={r.status} />
                  {r.status !== "revoked" && (
                    <span className="ml-auto">
                      <ConfirmButton
                        title={`Revoke from ${fullName(r.user)}?`}
                        description="The public badge page will show it as revoked."
                        confirmLabel="Revoke"
                        variant="ghost"
                        size="sm"
                        onConfirm={async () => {
                          try {
                            await api(`/badges/issues/${r.id}/revoke`, { body: {} });
                            toast.success("Badge revoked");
                            refresh();
                          } catch (err) {
                            toast.error(errorMessage(err));
                          }
                        }}
                      >
                        <ShieldOff /> Revoke
                      </ConfirmButton>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </QueryState>
        </section>
      </DialogContent>
    </Dialog>
  );
}

/** Badge management for a course (courseId) or the site (courseId = null). */
export function BadgeManager({ courseId, course, canAward = true }: { courseId: string | null; course?: CourseOverview; canAward?: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: listKey(courseId), queryFn: () => api<ManagedBadge[]>("/badges", { query: { courseId: courseId ?? undefined } }) });
  const [editing, setEditing] = useState<ManagedBadge | "new" | null>(null);
  const [recipientsOf, setRecipientsOf] = useState<ManagedBadge | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setEditing("new")}>
          <Plus /> New badge
        </Button>
      </div>
      <QueryState query={q}>
        {q.data && !q.data.length && <EmptyState title="No badges yet" description="Badges reward learners for completing courses or activities." />}
        {q.data && q.data.length > 0 && (
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {q.data.map((b) => (
              <li key={b.id}>
                <Card className="h-full">
                  <CardContent className="flex h-full flex-col gap-3">
                    <div className="flex items-start gap-3">
                      <BadgeImage badgeId={b.id} hasImage={!!b.imageFileId} className="size-14" />
                      <div className="min-w-0 flex-1">
                        <p className="font-medium">{b.name}</p>
                        <p className="line-clamp-2 text-sm text-muted-foreground">{b.description}</p>
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">{b.criteriaText}</p>
                    <div className="mt-auto flex flex-wrap items-center gap-2">
                      {b.status !== "active" && <Badge variant="outline">Inactive</Badge>}
                      <Badge variant="secondary">
                        {b.recipients} recipient{b.recipients === 1 ? "" : "s"}
                      </Badge>
                      <div className="ml-auto flex gap-1">
                        {canAward && (
                          <Button variant="ghost" size="icon-sm" aria-label={`Recipients of ${b.name}`} onClick={() => setRecipientsOf(b)}>
                            <Users />
                          </Button>
                        )}
                        <Button variant="ghost" size="icon-sm" aria-label={`Edit ${b.name}`} onClick={() => setEditing(b)}>
                          <Pencil />
                        </Button>
                        <ConfirmButton
                          title={`Delete "${b.name}"?`}
                          description="All awards of this badge are deleted too and their public pages stop working."
                          confirmLabel="Delete"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Delete ${b.name}`}
                          onConfirm={async () => {
                            try {
                              await api(`/badges/${b.id}`, { method: "DELETE" });
                              toast.success("Badge deleted");
                              void qc.invalidateQueries({ queryKey: ["badges"] });
                            } catch (err) {
                              toast.error(errorMessage(err));
                            }
                          }}
                        >
                          <Trash2 />
                        </ConfirmButton>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </QueryState>
      <BadgeDialog
        key={editing === null ? "closed" : editing === "new" ? "new" : editing.id}
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        courseId={courseId}
        course={course}
        badge={editing && editing !== "new" ? editing : undefined}
      />
      {recipientsOf && <RecipientsDialog badge={recipientsOf} open onOpenChange={(o) => !o && setRecipientsOf(null)} />}
    </div>
  );
}
