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
import { useT } from "@/lib/i18n";
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
  const t = useT();
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
      toast.success(group ? t("admin.groups.updated", "Group updated") : t("admin.groups.created", "Group created"));
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
          <DialogTitle>{group ? t("admin.groups.editGroup", "Edit group") : t("admin.groups.newGroup", "New group")}</DialogTitle>
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
          <Field id="g-name" label={t("common.name", "Name")}>
            <Input id="g-name" required maxLength={255} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field id="g-desc" label={t("common.description", "Description")}>
            <Textarea id="g-desc" rows={2} maxLength={5000} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">
              {t("admin.groups.members", "Members")}{" "}
              <span className="font-normal text-muted-foreground">{t("admin.groups.selectedCount", "({count} selected)", { count: members.size })}</span>
            </legend>
            <div className="relative">
              <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-8"
                type="search"
                placeholder={t("admin.groups.filterParticipants", "Filter participants")}
                aria-label={t("admin.groups.filterParticipants", "Filter participants")}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
            <ul className="max-h-60 divide-y overflow-auto rounded-md border">
              {shown.length === 0 && (
                <li role="status" className="p-2 text-sm text-muted-foreground">
                  {t("admin.groups.noParticipants", "No participants.")}
                </li>
              )}
              {shown.map((p) => (
                <li key={p.id}>
                  <label className="flex cursor-pointer items-center gap-2 p-2 text-sm hover:bg-muted/50 has-focus-visible:ring-2 has-focus-visible:ring-ring">
                    <input type="checkbox" checked={members.has(p.id)} onChange={() => toggle(p.id)} />
                    <span className="min-w-0 flex-1 truncate">{fullName(p)}</span>
                    {p.status === "suspended" && <span className="text-xs text-muted-foreground">{t("admin.groups.suspended", "suspended")}</span>}
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("common.cancel", "Cancel")}
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? t("common.saving", "Saving…") : t("admin.groups.saveGroup", "Save group")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function CourseGroups() {
  const t = useT();
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
      toast.success(t("admin.groups.deleted", "Group deleted"));
      setDeleting(null);
      void qc.invalidateQueries({ queryKey: groupsKey(courseId) });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (!course.data) return null;
  if (!canManage) return <EmptyState title={t("admin.groups.cantManage", "You can't manage groups in this course")} />;
  const nameOf = new Map((participants.data ?? []).map((p) => [p.id, fullName(p)]));

  return (
    <div>
      <PageHeader
        title={t("admin.groups.title", "Groups")}
        className="mb-4"
        description={t("admin.groups.description", "Groups split participants for separate forums, assignments and reports.")}
        actions={
          <Button onClick={() => setEditing("new")} disabled={!participants.data}>
            <Plus aria-hidden /> {t("admin.groups.newGroup", "New group")}
          </Button>
        }
      />
      <QueryState query={groups}>
        {groups.data?.length === 0 ? (
          <EmptyState title={t("admin.groups.empty", "No groups yet")} />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {groups.data?.map((g) => (
              <Card key={g.id}>
                <CardHeader className="flex flex-row items-start justify-between gap-2">
                  <div className="min-w-0">
                    <CardTitle className="truncate">{g.name}</CardTitle>
                    <CardDescription>
                      {g.memberIds.length === 1 ? t("admin.shared.memberCount.one", "1 member") : t("admin.shared.memberCount.other", "{count} members", { count: g.memberIds.length })}
                    </CardDescription>
                  </div>
                  <div className="flex shrink-0">
                    <Button variant="ghost" size="icon-sm" aria-label={t("admin.shared.editName", "Edit {name}", { name: g.name })} onClick={() => setEditing(g)} disabled={!participants.data}>
                      <Pencil aria-hidden />
                    </Button>
                    <Button variant="ghost" size="icon-sm" aria-label={t("admin.shared.deleteName", "Delete {name}", { name: g.name })} onClick={() => setDeleting(g)}>
                      <Trash2 aria-hidden />
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
      {participants.isError && <ErrorAlert error={participants.error} title={t("admin.groups.loadParticipantsError", "Could not load participants")} />}
      {editing && participants.data && (
        <GroupDialog courseId={courseId} group={editing === "new" ? null : editing} participants={participants.data} onClose={() => setEditing(null)} />
      )}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={t("admin.shared.deleteTitle", "Delete {name}?", { name: deleting?.name ?? "" })}
        description={t("admin.groups.deleteDescription", "Members stay enrolled in the course.")}
        confirmLabel={t("admin.groups.deleteGroup", "Delete group")}
        destructive
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </div>
  );
}
