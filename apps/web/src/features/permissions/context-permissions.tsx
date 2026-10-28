"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Search, Trash2, UserPlus } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { EmptyState, QueryState, fullName } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api, errorMessage } from "@/lib/api";
import { useT, type Translate } from "@/lib/i18n";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { capabilityText, Field, NativeSelect, useDebounced } from "../admin/shared";
import type { CapabilityDef, Permission, Role } from "../admin/types";
import { permissionKeys, useCapabilityDefs, useCourseParticipants, useOverrides, useRoleAssignments, useRoles, type ContextLevel, type Override } from "./api";

/** Capability levels that can be overridden in each kind of context. */
const LEVELS: Record<ContextLevel, string[]> = { course: ["course", "activity"], activity: ["activity"] };

const PERMISSION_STYLE: Record<Permission, string> = {
  allow: "border-green-600/40 bg-green-600/10",
  prevent: "border-amber-600/40 bg-amber-600/10",
  prohibit: "border-destructive/50 bg-destructive/10",
};

const permissionLabel = (t: Translate, p: Permission | null) =>
  p === "allow"
    ? t("permissions.allow", "Allow")
    : p === "prevent"
      ? t("permissions.prevent", "Prevent")
      : p === "prohibit"
        ? t("permissions.prohibit", "Prohibit")
        : t("permissions.notSet", "Not set");

type Cell = `${string}|${string}`;
const cellKey = (roleId: string, capability: string): Cell => `${roleId}|${capability}`;

/**
 * Role assignments and permission overrides of one course or activity context.
 * `courseId` is used to pick users (course participants) for new role assignments.
 */
export function ContextPermissions({ contextId, level, courseId, preferredPrefix }: { contextId: string; level: ContextLevel; courseId: string; preferredPrefix?: string }) {
  return (
    <div className="space-y-6">
      <RoleAssignments contextId={contextId} level={level} courseId={courseId} />
      <OverridesMatrix contextId={contextId} level={level} preferredPrefix={preferredPrefix} />
    </div>
  );
}

// ─── Role assignments ───────────────────────────────────────────────────────

function RoleAssignments({ contextId, level, courseId }: { contextId: string; level: ContextLevel; courseId: string }) {
  const t = useT();
  const qc = useQueryClient();
  const assignments = useRoleAssignments(contextId);
  const roles = useRoles();
  const session = useSession();
  const assignable = (roles.data ?? []).filter(
    (r) => r.assignableLevels.includes(level) && (!["super_admin", "org_admin"].includes(r.archetype) || session.can("role:manage")),
  );
  const [roleId, setRoleId] = useState("");
  const [search, setSearch] = useState("");
  const [userId, setUserId] = useState("");
  const debounced = useDebounced(search);
  const people = useCourseParticipants(courseId, debounced);
  const chosenRole = roleId || assignable[0]?.id || "";

  const refresh = () => qc.invalidateQueries({ queryKey: permissionKeys.assignments(contextId) });
  const assign = useMutation({
    mutationFn: () => api("/role-assignments", { body: { userId, roleId: chosenRole, contextId } }),
    onSuccess: () => {
      toast.success(t("permissions.assigned", "Role assigned"));
      setUserId("");
      void refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/role-assignments/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(t("permissions.unassigned", "Role removed"));
      void refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("permissions.assignmentsTitle", "Role assignments")}</CardTitle>
        <CardDescription>
          {level === "course"
            ? t("permissions.assignmentsHelpCourse", "Roles held directly in this course. Enrolment roles appear here too.")
            : t("permissions.assignmentsHelpActivity", "Extra roles held only in this activity, on top of the course roles.")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <QueryState query={assignments}>
          {assignments.data &&
            (assignments.data.length ? (
              <ul className="divide-y rounded-lg border">
                {assignments.data.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-2 p-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{fullName(a.user)}</p>
                      <p className="truncate text-xs text-muted-foreground">{a.user.email}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Badge variant="secondary">{a.roleName}</Badge>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("permissions.removeRole", "Remove {role} from {name}", { role: a.roleName, name: fullName(a.user) })}
                        disabled={remove.isPending}
                        onClick={() => {
                          if (window.confirm(t("permissions.confirmRemove", "Remove the {role} role from {name}?", { role: a.roleName, name: fullName(a.user) }))) remove.mutate(a.id);
                        }}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">{t("permissions.noAssignments", "No roles are assigned directly in this context.")}</p>
            ))}
        </QueryState>

        <form
          className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            if (userId && chosenRole) assign.mutate();
          }}
        >
          <Field id="pa-search" label={t("permissions.user", "User")}>
            <Input
              id="pa-search"
              type="search"
              placeholder={t("permissions.searchParticipants", "Search course participants")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <NativeSelect aria-label={t("permissions.chooseUser", "Choose a user")} value={userId} onChange={(e) => setUserId(e.target.value)} required>
              <option value="">{people.isPending ? t("common.loading", "Loading…") : t("permissions.chooseUser", "Choose a user")}</option>
              {people.data?.items.map((p) => (
                <option key={p.id} value={p.id}>
                  {fullName(p)}
                  {p.email ? ` (${p.email})` : ""}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field id="pa-role" label={t("permissions.role", "Role")}>
            <NativeSelect id="pa-role" value={chosenRole} onChange={(e) => setRoleId(e.target.value)} required>
              {assignable.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Button type="submit" disabled={!userId || !chosenRole || assign.isPending}>
            <UserPlus /> {t("permissions.assign", "Assign role")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

// ─── Overrides matrix ───────────────────────────────────────────────────────

function OverridesMatrix({ contextId, level, preferredPrefix }: { contextId: string; level: ContextLevel; preferredPrefix?: string }) {
  const t = useT();
  const roles = useRoles();
  const caps = useCapabilityDefs();
  const overrides = useOverrides(contextId);
  const editableRoles = (roles.data ?? []).filter((r) => r.archetype !== "super_admin");

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("permissions.overridesTitle", "Permission overrides")}</CardTitle>
        <CardDescription>
          {level === "course"
            ? t("permissions.overridesHelpCourse", "Change what a role may do in this course and its activities. “Inherit” uses the role's default (or a parent override).")
            : t("permissions.overridesHelpActivity", "Change what a role may do in this activity only. “Inherit” uses the course setting or the role's default.")}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <QueryState query={roles.isPending ? roles : caps.isPending ? caps : overrides}>
          {roles.data && caps.data && overrides.data && (
            editableRoles.length ? (
              <Matrix
                contextId={contextId}
                roles={editableRoles}
                capabilities={caps.data.filter((c) => LEVELS[level].includes(c.level))}
                overrides={overrides.data}
                preferredPrefix={preferredPrefix}
              />
            ) : (
              <EmptyState title={t("permissions.noRoles", "No roles")} />
            )
          )}
        </QueryState>
      </CardContent>
    </Card>
  );
}

function Matrix({
  contextId,
  roles,
  capabilities,
  overrides,
  preferredPrefix,
}: {
  contextId: string;
  roles: Role[];
  capabilities: CapabilityDef[];
  overrides: Override[];
  preferredPrefix?: string;
}) {
  const t = useT();
  const qc = useQueryClient();
  const session = useSession();
  const canProhibit = session.can("role:manage");
  const [roleId, setRoleId] = useState(roles[0]!.id);
  const role = roles.find((r) => r.id === roleId) ?? roles[0]!;
  const [draft, setDraft] = useState<Record<Cell, Permission | null>>({});
  const [filter, setFilter] = useState("");
  const [onlySet, setOnlySet] = useState(false);

  const saved = useMemo(() => new Map(overrides.map((o) => [cellKey(o.roleId, o.capability), o.permission])), [overrides]);
  const savedOf = (rid: string, cap: string) => saved.get(cellKey(rid, cap)) ?? null;
  const valueOf = (rid: string, cap: string) => {
    const k = cellKey(rid, cap);
    return k in draft ? draft[k]! : savedOf(rid, cap);
  };

  const changes = (Object.entries(draft) as [Cell, Permission | null][]).filter(([k, p]) => {
    const [rid, cap] = k.split("|") as [string, string];
    return savedOf(rid, cap) !== p;
  });
  const countFor = (rid: string) => overrides.filter((o) => o.roleId === rid).length;
  const changedFor = (rid: string) => changes.filter(([k]) => k.startsWith(`${rid}|`)).length;

  const grouped = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const groups = new Map<string, CapabilityDef[]>();
    for (const c of capabilities) {
      const k = cellKey(role.id, c.name);
      const v = k in draft ? draft[k] : (saved.get(k) ?? null);
      if (onlySet && !v) continue;
      if (f && !c.name.toLowerCase().includes(f) && !capabilityText(t, c).toLowerCase().includes(f)) continue;
      const prefix = c.name.split(":")[0] ?? "other";
      groups.set(prefix, [...(groups.get(prefix) ?? []), c]);
    }
    return [...groups.entries()].sort(([a], [b]) => (a === preferredPrefix ? -1 : b === preferredPrefix ? 1 : a.localeCompare(b)));
  }, [capabilities, filter, onlySet, draft, saved, role.id, preferredPrefix, t]);

  const save = useMutation({
    mutationFn: async () => {
      // One PUT per changed cell; stop at the first failure and keep the rest as unsaved.
      const done: Cell[] = [];
      try {
        for (const [k, permission] of changes) {
          const [rid, capability] = k.split("|") as [string, string];
          await api(`/contexts/${contextId}/overrides`, { method: "PUT", body: { roleId: rid, capability, permission } });
          done.push(k);
        }
      } finally {
        if (done.length) {
          setDraft((d) => {
            const next = { ...d };
            for (const k of done) delete next[k];
            return next;
          });
          await qc.invalidateQueries({ queryKey: permissionKeys.overrides(contextId) });
        }
      }
      return done.length;
    },
    onSuccess: (n) => toast.success(t("permissions.saved", "{count} permission change(s) saved", { count: n })),
    onError: (e) => toast.error(errorMessage(e)),
  });

  const riskyAllowed = changes.filter(([k, p]) => p === "allow" && capabilities.find((c) => c.name === k.split("|")[1])?.risky).length;

  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-[minmax(12rem,16rem)_1fr] sm:items-end">
        <Field id="ov-role" label={t("permissions.role", "Role")}>
          <NativeSelect id="ov-role" value={role.id} onChange={(e) => setRoleId(e.target.value)}>
            {roles.map((r) => {
              const n = countFor(r.id);
              const c = changedFor(r.id);
              return (
                <option key={r.id} value={r.id}>
                  {r.name}
                  {n ? ` · ${t("permissions.overrideCount", "{count} override(s)", { count: n })}` : ""}
                  {c ? ` · ${t("permissions.unsavedCount", "{count} unsaved", { count: c })}` : ""}
                </option>
              );
            })}
          </NativeSelect>
        </Field>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-8"
              type="search"
              placeholder={t("permissions.filter", "Filter capabilities")}
              aria-label={t("permissions.filter", "Filter capabilities")}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          <label className="flex items-center gap-2 text-sm whitespace-nowrap">
            <input type="checkbox" checked={onlySet} onChange={(e) => setOnlySet(e.target.checked)} /> {t("permissions.onlyOverridden", "Only overridden")}
          </label>
        </div>
      </div>

      {grouped.map(([prefix, caps]) => (
        <section key={prefix} aria-labelledby={`ov-${prefix}`}>
          <h3 id={`ov-${prefix}`} className="mb-1 text-sm font-semibold capitalize">
            {prefix}
          </h3>
          <ul className="divide-y rounded-lg border">
            {caps.map((c) => {
              const value = valueOf(role.id, c.name);
              const changed = savedOf(role.id, c.name) !== value;
              const roleDefault = role.capabilities[c.name] ?? null;
              return (
                <li key={c.name} className={cn("flex flex-col gap-2 p-2.5 sm:flex-row sm:items-center sm:justify-between", changed && "bg-primary/5")}>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <code className="text-xs">{c.name}</code>
                      {c.risky && (
                        <Badge variant="destructive" className="gap-1">
                          <AlertTriangle className="size-3" /> {t("permissions.risky", "Risky")}
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">{capabilityText(t, c)}</p>
                    <p className="text-xs text-muted-foreground">{t("permissions.roleDefault", "Role default: {value}", { value: permissionLabel(t, roleDefault) })}</p>
                  </div>
                  <NativeSelect
                    aria-label={t("permissions.cellLabel", "{role}: permission for {capability}", { role: role.name, capability: c.name })}
                    className={cn("sm:w-36", value && PERMISSION_STYLE[value])}
                    value={value ?? ""}
                    onChange={(e) => setDraft({ ...draft, [cellKey(role.id, c.name)]: (e.target.value || null) as Permission | null })}
                  >
                    <option value="">{t("permissions.inherit", "Inherit")}</option>
                    <option value="allow">{t("permissions.allow", "Allow")}</option>
                    <option value="prevent">{t("permissions.prevent", "Prevent")}</option>
                    {(canProhibit || value === "prohibit") && (
                      <option value="prohibit" disabled={!canProhibit}>
                        {t("permissions.prohibit", "Prohibit")}
                      </option>
                    )}
                  </NativeSelect>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {grouped.length === 0 && <p className="text-sm text-muted-foreground">{t("permissions.noMatch", "No capabilities match.")}</p>}

      <div className="sticky bottom-0 flex flex-col gap-2 border-t bg-background/95 py-3 backdrop-blur sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {changes.length ? t("permissions.unsaved", "{count} unsaved change(s)", { count: changes.length }) : t("permissions.noChanges", "No changes")}
          {riskyAllowed > 0 && <span className="ml-1 text-destructive">· {t("permissions.riskyAllowed", "allows {count} risky capability(ies)", { count: riskyAllowed })}</span>}
        </p>
        <div className="flex gap-2">
          <Button variant="outline" disabled={!changes.length || save.isPending} onClick={() => setDraft({})}>
            {t("permissions.discard", "Discard")}
          </Button>
          <Button disabled={!changes.length || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? t("common.saving", "Saving…") : t("permissions.save", "Save permissions")}
          </Button>
        </div>
      </div>
    </div>
  );
}
