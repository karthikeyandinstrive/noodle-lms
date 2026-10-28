"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Search, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState, ErrorAlert, PageHeader, QueryState, fullName } from "@/components/common";
import { useCourse } from "@/features/courses/use-course";
import { api, errorMessage, type Paged } from "@/lib/api";
import { ConfirmDialog, Field } from "./shared";
import type { Group, Participant } from "./types";

const groupsKey = (courseId: string) => ["course", courseId, "groups"] as const;

/** Every participant of the course (pages through the API, 100 at a time). */
function useAllParticipants(courseId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["course", courseId, "participants", "all"],
    enabled,
    queryFn: async () => {
      const all: Participant[] = [];
      for (let page = 1; page <= 50; page++) {
        const r = await api<Paged<Participant>>(`/courses/${courseId}/participants`, { query: { page, pageSize: 100 } });
        all.push(...r.items);
        if (all.length >= r.total || r.items.length === 0) break;
      }
      return all;
    },
  });
}

function GroupDialog({ courseId, group, participants, onClose }: { courseId: string; group: Group | null; participants: Participant[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(group?.name ?? "");
  const [description, setDescription] = useState(group?.description ?? "");
  const [members, setMembers] = useState<Set<string>>(new Set(group?.memberIds ?? []));
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<unknown>(null);
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? participants.filter((p) => `${fullName(p)} ${p.email ?? ""}`.toLowerCase().includes(f)) : participants;
  }, [participants, filter]);
  const save = useMutation({
    mutationFn: () => {
      const body = { name, description: description || null, memberIds: [...members] };
      return group ? api(`/courses/${courseId}/groups/${group.id}`, { method: "PATCH", body }) : api(`/courses/${courseId}/groups`, { body });
    },
    onSuccess: () => {
      toast.success(group ? "Group updated" : "Group created");
      void qc.invalidateQueries({ queryKey: groupsKey(courseId) });
      onClose();
    },
    onError: setError,
  });
  const toggle = (id: string) =>
    setMembers((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{group ? "Edit group" : "New group"}</DialogTitle>
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
          <Field id="g-name" label="Name">
            <Input id="g-name" required maxLength={255} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field id="g-desc" label="Description">
            <Textarea id="g-desc" rows={2} maxLength={5000} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">
              Members <span className="font-normal text-muted-foreground">({members.size} selected)</span>
            </legend>
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input className="pl-8" type="search" placeholder="Filter participants" aria-label="Filter participants" value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>
            <ul className="max-h-60 divide-y overflow-auto rounded-md border">
              {shown.length === 0 && <li className="p-2 text-sm text-muted-foreground">No participants.</li>}
              {shown.map((p) => (
                <li key={p.id}>
                  <label className="flex cursor-pointer items-center gap-2 p-2 text-sm hover:bg-muted/50">
                    <input type="checkbox" checked={members.has(p.id)} onChange={() => toggle(p.id)} />
                    <span className="min-w-0 flex-1 truncate">{fullName(p)}</span>
                    {p.status === "suspended" && <span className="text-xs text-muted-foreground">suspended</span>}
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? "Saving…" : "Save group"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function CourseGroups() {
  const course = useCourse();
  const qc = useQueryClient();
  const courseId = course.courseId;
  const canManage = course.can("course:manage_groups");
  const groups = useQuery({ queryKey: groupsKey(courseId), queryFn: () => api<Group[]>(`/courses/${courseId}/groups`), enabled: !!course.data });
  const participants = useAllParticipants(courseId, canManage && course.can("course:view_participants"));
  const [editing, setEditing] = useState<Group | "new" | null>(null);
  const [deleting, setDeleting] = useState<Group | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) => api(`/courses/${courseId}/groups/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Group deleted");
      setDeleting(null);
      void qc.invalidateQueries({ queryKey: groupsKey(courseId) });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (!course.data) return null;
  if (!canManage) return <EmptyState title="You can't manage groups in this course" />;
  const nameOf = new Map((participants.data ?? []).map((p) => [p.id, fullName(p)]));

  return (
    <div>
      <PageHeader
        title="Groups"
        className="mb-4"
        description="Groups split participants for separate forums, assignments and reports."
        actions={
          <Button onClick={() => setEditing("new")} disabled={!participants.data}>
            <Plus /> New group
          </Button>
        }
      />
      <QueryState query={groups}>
        {groups.data?.length === 0 ? (
          <EmptyState title="No groups yet" />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {groups.data?.map((g) => (
              <Card key={g.id}>
                <CardHeader className="flex flex-row items-start justify-between gap-2">
                  <div className="min-w-0">
                    <CardTitle className="truncate">{g.name}</CardTitle>
                    <CardDescription>
                      {g.memberIds.length} member{g.memberIds.length === 1 ? "" : "s"}
                    </CardDescription>
                  </div>
                  <div className="flex shrink-0">
                    <Button variant="ghost" size="icon-sm" aria-label={`Edit ${g.name}`} onClick={() => setEditing(g)} disabled={!participants.data}>
                      <Pencil />
                    </Button>
                    <Button variant="ghost" size="icon-sm" aria-label={`Delete ${g.name}`} onClick={() => setDeleting(g)}>
                      <Trash2 />
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="space-y-2">
                  {g.description && <p className="line-clamp-2 text-sm text-muted-foreground">{g.description}</p>}
                  {g.memberIds.length > 0 && (
                    <p className="line-clamp-3 text-sm">
                      {g.memberIds
                        .map((id) => nameOf.get(id))
                        .filter(Boolean)
                        .join(", ")}
                    </p>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </QueryState>
      {participants.isError && <ErrorAlert error={participants.error} title="Could not load participants" />}
      {editing && participants.data && (
        <GroupDialog courseId={courseId} group={editing === "new" ? null : editing} participants={participants.data} onClose={() => setEditing(null)} />
      )}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete ${deleting?.name}?`}
        description="Members stay enrolled in the course."
        confirmLabel="Delete group"
        destructive
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </div>
  );
}
