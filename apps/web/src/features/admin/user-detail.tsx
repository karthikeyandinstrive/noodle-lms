"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, KeyRound, Trash2, UserCheck, UserX, X } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ErrorAlert, PageHeader, QueryState, formatDate, fullName } from "@/components/common";
import { api, errorMessage } from "@/lib/api";
import { useSession } from "@/lib/session";
import { ConfirmDialog, Field, NativeSelect, RequireCapability } from "./shared";
import type { AdminUserDetail, Role, RoleAssignment } from "./types";
import { StatusBadge, usersKey } from "./users";

const userKey = (id: string) => [...usersKey, id] as const;

function ProfileCard({ user, canManage }: { user: AdminUserDetail; canManage: boolean }) {
  const qc = useQueryClient();
  const [v, setV] = useState({ firstName: user.firstName, lastName: user.lastName, email: user.email, locale: user.locale, timezone: user.timezone });
  const save = useMutation({
    mutationFn: () => api(`/users/${user.id}`, { method: "PATCH", body: v }),
    onSuccess: () => {
      toast.success("Profile saved");
      void qc.invalidateQueries({ queryKey: usersKey });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <fieldset disabled={!canManage} className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id="u-first" label="First name">
                <Input id="u-first" required maxLength={100} value={v.firstName} onChange={(e) => setV({ ...v, firstName: e.target.value })} />
              </Field>
              <Field id="u-last" label="Last name">
                <Input id="u-last" required maxLength={100} value={v.lastName} onChange={(e) => setV({ ...v, lastName: e.target.value })} />
              </Field>
            </div>
            <Field id="u-email" label="Email">
              <Input id="u-email" type="email" required maxLength={320} value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id="u-locale" label="Language">
                <Input id="u-locale" maxLength={10} value={v.locale} onChange={(e) => setV({ ...v, locale: e.target.value })} />
              </Field>
              <Field id="u-tz" label="Time zone">
                <Input id="u-tz" maxLength={64} value={v.timezone} onChange={(e) => setV({ ...v, timezone: e.target.value })} />
              </Field>
            </div>
          </fieldset>
          {canManage && (
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? "Saving…" : "Save changes"}
            </Button>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

function SiteRolesCard({ user }: { user: AdminUserDetail }) {
  const session = useSession();
  const qc = useQueryClient();
  const systemContextId = session.organization?.systemContextId ?? null;
  const canAssign = session.can("role:manage") && !!systemContextId;
  const [roleId, setRoleId] = useState("");

  const roles = useQuery({ queryKey: ["roles"], queryFn: () => api<Role[]>("/roles"), enabled: canAssign });
  const assignmentsKey = ["role-assignments", systemContextId] as const;
  const assignments = useQuery({
    queryKey: assignmentsKey,
    queryFn: () => api<RoleAssignment[]>(`/contexts/${systemContextId}/role-assignments`),
    enabled: canAssign,
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: assignmentsKey });
    void qc.invalidateQueries({ queryKey: userKey(user.id) });
  };
  const assign = useMutation({
    mutationFn: () => api("/role-assignments", { body: { userId: user.id, roleId, contextId: systemContextId } }),
    onSuccess: () => {
      toast.success("Role assigned");
      setRoleId("");
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const unassign = useMutation({
    mutationFn: (id: string) => api(`/role-assignments/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Role removed");
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const mine = assignments.data?.filter((a) => a.user.id === user.id) ?? [];
  const assignable = roles.data?.filter((r) => r.assignableLevels.includes("system") && !mine.some((m) => m.roleId === r.id)) ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Site roles</CardTitle>
        <CardDescription>Roles held across the whole organization (system context).</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!canAssign ? (
          user.siteRoles.length ? (
            <div className="flex flex-wrap gap-1.5">
              {user.siteRoles.map((r) => (
                <Badge key={r} variant="secondary">
                  {r}
                </Badge>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No site roles.</p>
          )
        ) : (
          <QueryState query={assignments}>
            {mine.length === 0 ? (
              <p className="text-sm text-muted-foreground">No site roles.</p>
            ) : (
              <ul className="flex flex-wrap gap-1.5">
                {mine.map((a) => (
                  <li key={a.id}>
                    <Badge variant="secondary" className="gap-1 pr-0.5">
                      {a.roleName}
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Remove ${a.roleName}`}
                        disabled={unassign.isPending}
                        onClick={() => {
                          if (confirm(`Remove the ${a.roleName} role from ${fullName(user)}?`)) unassign.mutate(a.id);
                        }}
                      >
                        <X />
                      </Button>
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
            <form
              className="flex flex-col gap-2 sm:flex-row"
              onSubmit={(e) => {
                e.preventDefault();
                if (roleId) assign.mutate();
              }}
            >
              <NativeSelect aria-label="Role to assign" value={roleId} onChange={(e) => setRoleId(e.target.value)} className="sm:max-w-xs">
                <option value="">Choose a role…</option>
                {assignable.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </NativeSelect>
              <Button type="submit" variant="outline" disabled={!roleId || assign.isPending}>
                Assign role
              </Button>
            </form>
          </QueryState>
        )}
      </CardContent>
    </Card>
  );
}

function SecurityCard({ user, canManage }: { user: AdminUserDetail; canManage: boolean }) {
  const qc = useQueryClient();
  const router = useRouter();
  const session = useSession();
  const [dialog, setDialog] = useState<null | "suspend" | "password" | "delete">(null);
  const [password, setPassword] = useState("");
  const isSelf = session.user?.id === user.id;

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => api(`/users/${user.id}`, { method: "PATCH", body }),
    onSuccess: (_d, body) => {
      toast.success(body.password ? "Password reset; the user was signed out everywhere" : body.status === "suspended" ? "User suspended and signed out" : "User reactivated");
      setDialog(null);
      setPassword("");
      void qc.invalidateQueries({ queryKey: usersKey });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: () => api(`/users/${user.id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("User deleted");
      void qc.invalidateQueries({ queryKey: usersKey });
      router.replace("/admin/users");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (!canManage) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Account</CardTitle>
        <CardDescription>
          Created {formatDate(user.createdAt, false)} · Last sign-in {formatDate(user.lastLoginAt)} · Email {user.emailVerifiedAt ? "verified" : "not verified"}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        {user.status === "suspended" ? (
          <Button variant="outline" onClick={() => patch.mutate({ status: "active" })} disabled={patch.isPending}>
            <UserCheck /> Reactivate
          </Button>
        ) : (
          <Button variant="outline" onClick={() => setDialog("suspend")} disabled={isSelf}>
            <UserX /> Suspend
          </Button>
        )}
        <Button variant="outline" onClick={() => setDialog("password")}>
          <KeyRound /> Reset password
        </Button>
        <Button variant="destructive" onClick={() => setDialog("delete")} disabled={isSelf}>
          <Trash2 /> Delete user
        </Button>
      </CardContent>

      <ConfirmDialog
        open={dialog === "suspend"}
        onOpenChange={(o) => !o && setDialog(null)}
        title={`Suspend ${fullName(user)}?`}
        description="They will be signed out of every device and won't be able to sign in until reactivated."
        confirmLabel="Suspend"
        destructive
        pending={patch.isPending}
        onConfirm={() => patch.mutate({ status: "suspended" })}
      />
      <ConfirmDialog
        open={dialog === "password"}
        onOpenChange={(o) => !o && setDialog(null)}
        title="Set a new password"
        description="The user will be signed out of every device. Share the new password through a secure channel."
        confirmLabel="Reset password"
        pending={patch.isPending}
        onConfirm={() => {
          if (password.length < 10) toast.error("Use at least 10 characters");
          else patch.mutate({ password });
        }}
      >
        <Field id="reset-pass" label="New password" hint="At least 10 characters.">
          <Input id="reset-pass" type="password" autoComplete="new-password" minLength={10} maxLength={200} required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
      </ConfirmDialog>
      <ConfirmDialog
        open={dialog === "delete"}
        onOpenChange={(o) => !o && setDialog(null)}
        title={`Delete ${fullName(user)}?`}
        description="Personal data is anonymized and cannot be recovered. Learning records (grades, submissions) are kept for reporting."
        confirmLabel="Delete user"
        destructive
        confirmText={user.email}
        pending={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </Card>
  );
}

export function UserDetail() {
  const { id } = useParams<{ id: string }>();
  const session = useSession();
  const user = useQuery({ queryKey: userKey(id), queryFn: () => api<AdminUserDetail>(`/users/${id}`) });
  const canManage = session.can("user:manage");
  return (
    <RequireCapability capability="user:view">
      <Button variant="ghost" size="sm" className="mb-2 -ml-2" render={<Link href="/admin/users" />}>
        <ArrowLeft /> All users
      </Button>
      <QueryState query={user}>
        {user.data && (
          <>
            <PageHeader
              title={
                <span className="flex flex-wrap items-center gap-2">
                  {fullName(user.data)} <StatusBadge status={user.data.status} />
                </span>
              }
              description={user.data.email}
            />
            {user.isError && <ErrorAlert error={user.error} />}
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-4">
                <ProfileCard key={user.data.id} user={user.data} canManage={canManage} />
                <SecurityCard user={user.data} canManage={canManage} />
              </div>
              <div className="space-y-4">
                <SiteRolesCard user={user.data} />
                <Card>
                  <CardHeader>
                    <CardTitle>Courses</CardTitle>
                  </CardHeader>
                  <CardContent>
                    {user.data.courses.length === 0 ? (
                      <p className="text-sm text-muted-foreground">Not enrolled in any course.</p>
                    ) : (
                      <ul className="divide-y">
                        {user.data.courses.map((c) => (
                          <li key={c.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                            <Link href={`/courses/${c.id}`} className="truncate hover:underline">
                              {c.fullname}
                            </Link>
                            {c.status !== "active" && <Badge variant="outline">{c.status}</Badge>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </CardContent>
                </Card>
              </div>
            </div>
          </>
        )}
      </QueryState>
    </RequireCapability>
  );
}
