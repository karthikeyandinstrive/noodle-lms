"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, KeyRound, Trash2, UserCheck, UserX, X } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ErrorAlert, PageHeader, QueryState, fullName } from "@/components/common";
import { api, errorMessage } from "@/lib/api";
import { useFormat, useT } from "@/lib/i18n";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { ConfirmDialog, Field, NativeSelect, RequireCapability } from "./shared";
import type { AdminUserDetail, Role, RoleAssignment } from "./types";
import { StatusBadge, usersKey } from "./users";

const userKey = (id: string) => [...usersKey, id] as const;

function ProfileCard({ user, canManage }: { user: AdminUserDetail; canManage: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const [v, setV] = useState({ firstName: user.firstName, lastName: user.lastName, email: user.email, locale: user.locale, timezone: user.timezone });
  const save = useMutation({
    mutationFn: () => api(`/users/${user.id}`, { method: "PATCH", body: v }),
    onSuccess: () => {
      toast.success(t("admin.userDetail.profileSaved", "Profile saved"));
      void qc.invalidateQueries({ queryKey: usersKey });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("admin.userDetail.profile", "Profile")}</CardTitle>
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
              <Field id="u-first" label={t("admin.shared.firstName", "First name")}>
                <Input id="u-first" required maxLength={100} value={v.firstName} onChange={(e) => setV({ ...v, firstName: e.target.value })} />
              </Field>
              <Field id="u-last" label={t("admin.shared.lastName", "Last name")}>
                <Input id="u-last" required maxLength={100} value={v.lastName} onChange={(e) => setV({ ...v, lastName: e.target.value })} />
              </Field>
            </div>
            <Field id="u-email" label={t("common.email", "Email")}>
              <Input id="u-email" type="email" required maxLength={320} value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id="u-locale" label={t("admin.userDetail.language", "Language")}>
                <Input id="u-locale" maxLength={10} value={v.locale} onChange={(e) => setV({ ...v, locale: e.target.value })} />
              </Field>
              <Field id="u-tz" label={t("admin.userDetail.timezone", "Time zone")}>
                <Input id="u-tz" maxLength={64} value={v.timezone} onChange={(e) => setV({ ...v, timezone: e.target.value })} />
              </Field>
            </div>
          </fieldset>
          {canManage && (
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? t("common.saving", "Saving…") : t("admin.shared.saveChanges", "Save changes")}
            </Button>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

function SiteRolesCard({ user }: { user: AdminUserDetail }) {
  const t = useT();
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
      toast.success(t("admin.userDetail.roleAssigned", "Role assigned"));
      setRoleId("");
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const unassign = useMutation({
    mutationFn: (id: string) => api(`/role-assignments/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(t("admin.userDetail.roleRemoved", "Role removed"));
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const mine = assignments.data?.filter((a) => a.user.id === user.id) ?? [];
  const assignable = roles.data?.filter((r) => r.assignableLevels.includes("system") && !mine.some((m) => m.roleId === r.id)) ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("admin.userDetail.siteRoles", "Site roles")}</CardTitle>
        <CardDescription>{t("admin.userDetail.siteRolesHelp", "Roles held across the whole organization (system context).")}</CardDescription>
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
            <p className="text-sm text-muted-foreground">{t("admin.userDetail.noSiteRoles", "No site roles.")}</p>
          )
        ) : (
          <QueryState query={assignments}>
            {mine.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("admin.userDetail.noSiteRoles", "No site roles.")}</p>
            ) : (
              <ul className="flex flex-wrap gap-1.5">
                {mine.map((a) => (
                  <li key={a.id}>
                    <Badge variant="secondary" className="gap-1 pr-0.5">
                      {a.roleName}
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={t("admin.userDetail.removeRole", "Remove {role}", { role: a.roleName })}
                        disabled={unassign.isPending}
                        onClick={() => {
                          if (confirm(t("admin.userDetail.confirmRemoveRole", "Remove the {role} role from {name}?", { role: a.roleName, name: fullName(user) }))) unassign.mutate(a.id);
                        }}
                      >
                        <X aria-hidden />
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
              <NativeSelect aria-label={t("admin.userDetail.roleToAssign", "Role to assign")} value={roleId} onChange={(e) => setRoleId(e.target.value)} className="sm:max-w-xs">
                <option value="">{t("admin.userDetail.chooseRole", "Choose a role…")}</option>
                {assignable.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </NativeSelect>
              <Button type="submit" variant="outline" disabled={!roleId || assign.isPending}>
                {t("admin.userDetail.assignRole", "Assign role")}
              </Button>
            </form>
          </QueryState>
        )}
      </CardContent>
    </Card>
  );
}

function SecurityCard({ user, canManage }: { user: AdminUserDetail; canManage: boolean }) {
  const t = useT();
  const fmt = useFormat();
  const qc = useQueryClient();
  const router = useRouter();
  const session = useSession();
  const [dialog, setDialog] = useState<null | "suspend" | "password" | "delete">(null);
  const [password, setPassword] = useState("");
  const isSelf = session.user?.id === user.id;

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => api(`/users/${user.id}`, { method: "PATCH", body }),
    onSuccess: (_d, body) => {
      toast.success(
        body.password
          ? t("admin.userDetail.passwordReset", "Password reset; the user was signed out everywhere")
          : body.status === "suspended"
            ? t("admin.userDetail.suspended", "User suspended and signed out")
            : t("admin.userDetail.reactivated", "User reactivated"),
      );
      setDialog(null);
      setPassword("");
      void qc.invalidateQueries({ queryKey: usersKey });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: () => api(`/users/${user.id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(t("admin.userDetail.deleted", "User deleted"));
      void qc.invalidateQueries({ queryKey: usersKey });
      router.replace("/admin/users");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (!canManage) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("admin.userDetail.account", "Account")}</CardTitle>
        <CardDescription>
          {t("admin.userDetail.accountMeta", "Created {created} · Last sign-in {lastLogin} · {verified}", {
            created: fmt.date(user.createdAt, false),
            lastLogin: fmt.date(user.lastLoginAt),
            verified: user.emailVerifiedAt ? t("admin.userDetail.emailVerified", "Email verified") : t("admin.userDetail.emailNotVerified", "Email not verified"),
          })}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        {user.status === "suspended" ? (
          <Button variant="outline" onClick={() => patch.mutate({ status: "active" })} disabled={patch.isPending}>
            <UserCheck aria-hidden /> {t("admin.userDetail.reactivate", "Reactivate")}
          </Button>
        ) : (
          <Button variant="outline" onClick={() => setDialog("suspend")} disabled={isSelf}>
            <UserX aria-hidden /> {t("admin.userDetail.suspend", "Suspend")}
          </Button>
        )}
        <Button variant="outline" onClick={() => setDialog("password")}>
          <KeyRound aria-hidden /> {t("admin.userDetail.resetPassword", "Reset password")}
        </Button>
        <Button variant="destructive" onClick={() => setDialog("delete")} disabled={isSelf}>
          <Trash2 aria-hidden /> {t("admin.userDetail.deleteUser", "Delete user")}
        </Button>
      </CardContent>

      <ConfirmDialog
        open={dialog === "suspend"}
        onOpenChange={(o) => !o && setDialog(null)}
        title={t("admin.userDetail.suspendTitle", "Suspend {name}?", { name: fullName(user) })}
        description={t("admin.userDetail.suspendDescription", "They will be signed out of every device and won't be able to sign in until reactivated.")}
        confirmLabel={t("admin.userDetail.suspend", "Suspend")}
        destructive
        pending={patch.isPending}
        onConfirm={() => patch.mutate({ status: "suspended" })}
      />
      <ConfirmDialog
        open={dialog === "password"}
        onOpenChange={(o) => !o && setDialog(null)}
        title={t("admin.userDetail.newPasswordTitle", "Set a new password")}
        description={t("admin.userDetail.newPasswordDescription", "The user will be signed out of every device. Share the new password through a secure channel.")}
        confirmLabel={t("admin.userDetail.resetPassword", "Reset password")}
        pending={patch.isPending}
        onConfirm={() => {
          if (password.length < 10) toast.error(t("admin.userDetail.passwordTooShort", "Use at least 10 characters"));
          else patch.mutate({ password });
        }}
      >
        <Field id="reset-pass" label={t("admin.userDetail.newPassword", "New password")} hint={t("admin.shared.passwordHint", "At least 10 characters.")}>
          <Input id="reset-pass" type="password" autoComplete="new-password" minLength={10} maxLength={200} required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
      </ConfirmDialog>
      <ConfirmDialog
        open={dialog === "delete"}
        onOpenChange={(o) => !o && setDialog(null)}
        title={t("admin.shared.deleteTitle", "Delete {name}?", { name: fullName(user) })}
        description={t("admin.userDetail.deleteDescription", "Personal data is anonymized and cannot be recovered. Learning records (grades, submissions) are kept for reporting.")}
        confirmLabel={t("admin.userDetail.deleteUser", "Delete user")}
        destructive
        confirmText={user.email}
        pending={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </Card>
  );
}

export function UserDetail() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const session = useSession();
  const user = useQuery({ queryKey: userKey(id), queryFn: () => api<AdminUserDetail>(`/users/${id}`) });
  const canManage = session.can("user:manage");
  return (
    <RequireCapability capability="user:view">
      <Link href="/admin/users" className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "mb-2 -ml-2")}>
        <ArrowLeft aria-hidden /> {t("admin.userDetail.allUsers", "All users")}
      </Link>
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
                    <CardTitle>{t("admin.userDetail.courses", "Courses")}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    {user.data.courses.length === 0 ? (
                      <p className="text-sm text-muted-foreground">{t("admin.userDetail.noCourses", "Not enrolled in any course.")}</p>
                    ) : (
                      <ul className="divide-y">
                        {user.data.courses.map((c) => (
                          <li key={c.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                            <Link href={`/courses/${c.id}`} className="truncate hover:underline">
                              {c.fullname}
                            </Link>
                            {c.status !== "active" && <Badge variant="outline">{c.status === "suspended" ? t("admin.shared.suspended", "Suspended") : c.status}</Badge>}
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
