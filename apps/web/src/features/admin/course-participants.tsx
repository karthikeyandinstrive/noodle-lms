"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal, Search, UserPlus, UsersRound, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, PageHeader, QueryState, formatDate, fullName } from "@/components/common";
import { courseKey, useCourse } from "@/features/courses/use-course";
import { api, errorMessage, type Paged } from "@/lib/api";
import { useSession } from "@/lib/session";
import { CohortEnrolDialog } from "./cohorts";
import { ConfirmDialog, Field, NativeSelect, Pager, useDebounced } from "./shared";
import { ENROL_ROLES, roleLabel, type AdminUser, type Participant } from "./types";
import { UserPicker } from "./user-picker";

export const participantsKey = (courseId: string) => ["course", courseId, "participants"] as const;

function EnrolUsersDialog({ courseId, canAssignRoles, open, onOpenChange }: { courseId: string; canAssignRoles: boolean; open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [picked, setPicked] = useState<AdminUser[]>([]);
  const [role, setRole] = useState("student");
  const [timeEnd, setTimeEnd] = useState("");
  const enrol = useMutation({
    mutationFn: () =>
      api<{ enrolled: number }>(`/courses/${courseId}/enrolments`, {
        body: { userIds: picked.map((u) => u.id), role, timeEnd: timeEnd ? new Date(`${timeEnd}T23:59:59`).toISOString() : null },
      }),
    onSuccess: (r) => {
      toast.success(`${r.enrolled} user${r.enrolled === 1 ? "" : "s"} enrolled`);
      void qc.invalidateQueries({ queryKey: participantsKey(courseId) });
      setPicked([]);
      onOpenChange(false);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const toggle = (u: AdminUser) => setPicked((p) => (p.some((x) => x.id === u.id) ? p.filter((x) => x.id !== u.id) : [...p, u]));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Enrol users</DialogTitle>
          <DialogDescription>Search people in your organization and choose their role in this course.</DialogDescription>
        </DialogHeader>
        <UserPicker multi selected={picked.map((u) => u.id)} onPick={toggle} />
        {picked.length > 0 && (
          <ul className="flex flex-wrap gap-1.5" aria-label="Selected users">
            {picked.map((u) => (
              <li key={u.id}>
                <Badge variant="secondary" className="gap-1 pr-0.5">
                  {fullName(u)}
                  <Button variant="ghost" size="icon-xs" aria-label={`Remove ${fullName(u)}`} onClick={() => toggle(u)}>
                    <X />
                  </Button>
                </Badge>
              </li>
            ))}
          </ul>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="enrol-role" label="Role">
            <NativeSelect id="enrol-role" value={role} onChange={(e) => setRole(e.target.value)}>
              {ENROL_ROLES.filter((r) => canAssignRoles || r.value === "student").map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field id="enrol-end" label="Enrolment ends" hint="Optional.">
            <Input id="enrol-end" type="date" value={timeEnd} onChange={(e) => setTimeEnd(e.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!picked.length || enrol.isPending} onClick={() => enrol.mutate()}>
            {enrol.isPending ? "Enrolling…" : `Enrol ${picked.length || ""}`.trim()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RolesDialog({ courseId, participant, onClose }: { courseId: string; participant: Participant; onClose: () => void }) {
  const qc = useQueryClient();
  const [roles, setRoles] = useState<string[]>(participant.roles.filter((r) => ENROL_ROLES.some((x) => x.value === r)));
  const save = useMutation({
    mutationFn: () => api(`/courses/${courseId}/enrolments/${participant.id}`, { method: "PATCH", body: { roles } }),
    onSuccess: () => {
      toast.success("Roles updated");
      void qc.invalidateQueries({ queryKey: participantsKey(courseId) });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Roles for ${fullName(participant)}`}
      confirmLabel="Save roles"
      pending={save.isPending}
      onConfirm={() => (roles.length ? save.mutate() : toast.error("Choose at least one role"))}
    >
      <fieldset className="space-y-2">
        <legend className="sr-only">Course roles</legend>
        {ENROL_ROLES.map((r) => (
          <label key={r.value} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={roles.includes(r.value)}
              onChange={(e) => setRoles(e.target.checked ? [...roles, r.value] : roles.filter((x) => x !== r.value))}
            />
            {r.label}
          </label>
        ))}
      </fieldset>
    </ConfirmDialog>
  );
}

export function CourseParticipants() {
  const course = useCourse();
  const session = useSession();
  const qc = useQueryClient();
  const courseId = course.courseId;
  const [search, setSearch] = useState("");
  const [role, setRole] = useState("");
  const [page, setPage] = useState(1);
  const [enrolling, setEnrolling] = useState(false);
  const [cohortEnrol, setCohortEnrol] = useState(false);
  const [editingRoles, setEditingRoles] = useState<Participant | null>(null);
  const [removing, setRemoving] = useState<Participant | null>(null);
  const q = useDebounced(search.trim());

  const participants = useQuery({
    queryKey: [...participantsKey(courseId), { q, role, page }],
    queryFn: () => api<Paged<Participant>>(`/courses/${courseId}/participants`, { query: { search: q, role, page, pageSize: 50 } }),
    placeholderData: keepPreviousData,
    enabled: course.can("course:view_participants"),
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: participantsKey(courseId) });
    void qc.invalidateQueries({ queryKey: courseKey(courseId) });
  };
  const setStatus = useMutation({
    mutationFn: (p: { userId: string; status: "active" | "suspended" }) => api(`/courses/${courseId}/enrolments/${p.userId}`, { method: "PATCH", body: { status: p.status } }),
    onSuccess: (_d, p) => {
      toast.success(p.status === "suspended" ? "Enrolment suspended" : "Enrolment reactivated");
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const unenrol = useMutation({
    mutationFn: (userId: string) => api(`/courses/${courseId}/enrolments/${userId}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("User unenrolled");
      setRemoving(null);
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (!course.data) return null;
  if (!course.can("course:view_participants")) return <EmptyState title="You can't view participants in this course" />;
  const canManage = course.can("course:enrol_manage");
  const canAssignRoles = course.can("role:assign");
  const canSearchUsers = session.can("user:view");
  const canCohort = session.can("cohort:manage");

  return (
    <div>
      <PageHeader
        title="Participants"
        className="mb-4"
        actions={
          canManage && (
            <>
              {canCohort && (
                <Button variant="outline" onClick={() => setCohortEnrol(true)}>
                  <UsersRound /> Enrol cohort
                </Button>
              )}
              {canSearchUsers && (
                <Button onClick={() => setEnrolling(true)}>
                  <UserPlus /> Enrol users
                </Button>
              )}
            </>
          )
        }
      />
      <div className="mb-4 flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-8"
            type="search"
            placeholder="Search participants"
            aria-label="Search participants"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <NativeSelect
          className="sm:w-48"
          aria-label="Filter by role"
          value={role}
          onChange={(e) => {
            setRole(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All roles</option>
          {ENROL_ROLES.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </NativeSelect>
      </div>
      <QueryState query={participants}>
        {participants.data && participants.data.items.length === 0 ? (
          <EmptyState title="No participants found" />
        ) : (
          participants.data && (
            <>
              <div className="overflow-x-auto rounded-xl border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Roles</TableHead>
                      <TableHead className="hidden md:table-cell">Enrolled</TableHead>
                      {canManage && <TableHead className="hidden lg:table-cell">Last sign-in</TableHead>}
                      {canManage && (
                        <TableHead>
                          <span className="sr-only">Actions</span>
                        </TableHead>
                      )}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {participants.data.items.map((p) => (
                      <TableRow key={p.id} className={p.status === "suspended" ? "opacity-70" : undefined}>
                        <TableCell>
                          <div className="font-medium">{fullName(p)}</div>
                          {p.email && <div className="max-w-56 truncate text-xs text-muted-foreground">{p.email}</div>}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            {p.roles.length === 0 && <span className="text-xs text-muted-foreground">No role</span>}
                            {p.roles.map((r) => (
                              <Badge key={r} variant="secondary">
                                {roleLabel(r)}
                              </Badge>
                            ))}
                            {p.status === "suspended" && <Badge variant="destructive">Suspended</Badge>}
                          </div>
                        </TableCell>
                        <TableCell className="hidden text-muted-foreground md:table-cell">
                          {formatDate(p.enrolledAt, false)}
                          <div className="text-xs capitalize">{p.method}</div>
                        </TableCell>
                        {canManage && <TableCell className="hidden text-muted-foreground lg:table-cell">{formatDate(p.lastLoginAt)}</TableCell>}
                        {canManage && (
                          <TableCell className="text-right">
                            <DropdownMenu>
                              <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${fullName(p)}`} />}>
                                <MoreHorizontal />
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                {canAssignRoles && <DropdownMenuItem onClick={() => setEditingRoles(p)}>Change roles</DropdownMenuItem>}
                                {p.status === "active" ? (
                                  <DropdownMenuItem onClick={() => setStatus.mutate({ userId: p.id, status: "suspended" })}>Suspend enrolment</DropdownMenuItem>
                                ) : (
                                  <DropdownMenuItem onClick={() => setStatus.mutate({ userId: p.id, status: "active" })}>Reactivate enrolment</DropdownMenuItem>
                                )}
                                <DropdownMenuSeparator />
                                <DropdownMenuItem variant="destructive" onClick={() => setRemoving(p)}>
                                  Unenrol
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </TableCell>
                        )}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <Pager page={participants.data.page} pageSize={participants.data.pageSize} total={participants.data.total} onPage={setPage} />
            </>
          )
        )}
      </QueryState>
      {canManage && canSearchUsers && <EnrolUsersDialog courseId={courseId} canAssignRoles={canAssignRoles} open={enrolling} onOpenChange={setEnrolling} />}
      {canManage && canCohort && cohortEnrol && <CohortEnrolDialog courseId={courseId} open onOpenChange={setCohortEnrol} onDone={refresh} />}
      {editingRoles && <RolesDialog courseId={courseId} participant={editingRoles} onClose={() => setEditingRoles(null)} />}
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Unenrol ${removing ? fullName(removing) : ""}?`}
        description="They lose access to the course and their course roles. Grades and submissions are kept."
        confirmLabel="Unenrol"
        destructive
        pending={unenrol.isPending}
        onConfirm={() => removing && unenrol.mutate(removing.id)}
      />
    </div>
  );
}
