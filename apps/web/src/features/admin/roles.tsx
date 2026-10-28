"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Plus, Search, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ErrorAlert, PageHeader, QueryState } from "@/components/common";
import { api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ConfirmDialog, Field, NativeSelect, RequireCapability } from "./shared";
import type { CapabilityDef, Permission, Role } from "./types";

const rolesKey = ["roles"] as const;
const LEVELS = ["system", "category", "course", "activity"] as const;
type Draft = Record<string, Permission | null>;

function CreateRoleDialog({ roles, open, onOpenChange, onCreated }: { roles: Role[]; open: boolean; onOpenChange: (o: boolean) => void; onCreated: (r: Role) => void }) {
  const qc = useQueryClient();
  const copyable = roles.filter((r) => r.archetype !== "super_admin");
  const [v, setV] = useState({ shortname: "", name: "", description: "", copyFromRoleId: copyable[0]?.id ?? "", levels: ["course"] as string[] });
  const [error, setError] = useState<unknown>(null);
  const create = useMutation({
    mutationFn: () =>
      api<Role>("/roles", {
        body: { shortname: v.shortname, name: v.name, description: v.description || null, copyFromRoleId: v.copyFromRoleId, assignableLevels: v.levels },
      }),
    onSuccess: (r) => {
      toast.success(`${r.name} created`);
      void qc.invalidateQueries({ queryKey: rolesKey });
      onCreated(r);
      onOpenChange(false);
    },
    onError: setError,
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New custom role</DialogTitle>
          <DialogDescription>The role starts with a copy of another role&apos;s permissions.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            if (!v.levels.length) setError(new Error("Choose at least one level"));
            else create.mutate();
          }}
        >
          {error ? <ErrorAlert error={error} /> : null}
          <Field id="r-name" label="Name">
            <Input id="r-name" required maxLength={100} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
          </Field>
          <Field id="r-short" label="Short name" hint="Lowercase letters, numbers and underscores.">
            <Input id="r-short" required pattern="[a-z0-9_]{2,50}" value={v.shortname} onChange={(e) => setV({ ...v, shortname: e.target.value.toLowerCase() })} />
          </Field>
          <Field id="r-desc" label="Description">
            <Textarea id="r-desc" rows={2} maxLength={1000} value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} />
          </Field>
          <Field id="r-copy" label="Copy permissions from">
            <NativeSelect id="r-copy" required value={v.copyFromRoleId} onChange={(e) => setV({ ...v, copyFromRoleId: e.target.value })}>
              {copyable.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <fieldset>
            <legend className="mb-1.5 text-sm font-medium">Can be assigned at</legend>
            <div className="flex flex-wrap gap-4">
              {LEVELS.map((l) => (
                <label key={l} className="flex items-center gap-1.5 text-sm capitalize">
                  <input
                    type="checkbox"
                    checked={v.levels.includes(l)}
                    onChange={(e) => setV({ ...v, levels: e.target.checked ? [...v.levels, l] : v.levels.filter((x) => x !== l) })}
                  />
                  {l}
                </label>
              ))}
            </div>
          </fieldset>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? "Creating…" : "Create role"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const PERMISSION_STYLE: Record<Permission, string> = {
  allow: "border-green-600/40 bg-green-600/10",
  prevent: "border-amber-600/40 bg-amber-600/10",
  prohibit: "border-destructive/50 bg-destructive/10",
};

function CapabilityMatrix({ role, capabilities }: { role: Role; capabilities: CapabilityDef[] }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft>({});
  const [filter, setFilter] = useState("");
  const [onlySet, setOnlySet] = useState(false);
  const readOnly = role.archetype === "super_admin";

  const grouped = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const groups = new Map<string, CapabilityDef[]>();
    for (const c of capabilities) {
      const value = c.name in draft ? draft[c.name] : (role.capabilities[c.name] ?? null);
      if (onlySet && !value) continue;
      if (f && !c.name.toLowerCase().includes(f) && !c.description.toLowerCase().includes(f)) continue;
      const prefix = c.name.split(":")[0] ?? "other";
      groups.set(prefix, [...(groups.get(prefix) ?? []), c]);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [capabilities, filter, onlySet, draft, role.capabilities]);

  const changes = Object.entries(draft).filter(([cap, p]) => (role.capabilities[cap] ?? null) !== p);
  const save = useMutation({
    mutationFn: () => api<Role>(`/roles/${role.id}`, { method: "PATCH", body: { capabilities: Object.fromEntries(changes) } }),
    onSuccess: () => {
      toast.success(`${role.name} permissions saved`);
      setDraft({});
      void qc.invalidateQueries({ queryKey: rolesKey });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const riskyAllowed = changes.filter(([cap, p]) => p === "allow" && capabilities.find((c) => c.name === cap)?.risky);

  return (
    <div className="space-y-4">
      {readOnly && <p className="text-sm text-muted-foreground">The super admin role always has every capability and cannot be edited.</p>}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-8" type="search" placeholder="Filter capabilities" aria-label="Filter capabilities" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={onlySet} onChange={(e) => setOnlySet(e.target.checked)} /> Only set permissions
        </label>
      </div>
      {grouped.map(([prefix, caps]) => (
        <section key={prefix} aria-labelledby={`cap-${prefix}`}>
          <h3 id={`cap-${prefix}`} className="mb-1 text-sm font-semibold capitalize">
            {prefix}
          </h3>
          <ul className="divide-y rounded-lg border">
            {caps.map((c) => {
              const value = c.name in draft ? draft[c.name]! : (role.capabilities[c.name] ?? null);
              const changed = c.name in draft && (role.capabilities[c.name] ?? null) !== draft[c.name];
              return (
                <li key={c.name} className={cn("flex flex-col gap-2 p-2.5 sm:flex-row sm:items-center sm:justify-between", changed && "bg-primary/5")}>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <code className="text-xs">{c.name}</code>
                      {c.risky && (
                        <Badge variant="destructive" className="gap-1">
                          <AlertTriangle className="size-3" /> Risky
                        </Badge>
                      )}
                      <Badge variant="outline">{c.level}</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">{c.description}</p>
                  </div>
                  <NativeSelect
                    aria-label={`Permission for ${c.name}`}
                    disabled={readOnly}
                    className={cn("sm:w-36", value && PERMISSION_STYLE[value])}
                    value={value ?? ""}
                    onChange={(e) => setDraft({ ...draft, [c.name]: (e.target.value || null) as Permission | null })}
                  >
                    <option value="">Not set</option>
                    <option value="allow">Allow</option>
                    <option value="prevent">Prevent</option>
                    <option value="prohibit">Prohibit</option>
                  </NativeSelect>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {grouped.length === 0 && <p className="text-sm text-muted-foreground">No capabilities match.</p>}
      {!readOnly && (
        <div className="sticky bottom-0 flex flex-col gap-2 border-t bg-background/95 py-3 backdrop-blur sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {changes.length ? `${changes.length} unsaved change${changes.length === 1 ? "" : "s"}` : "No changes"}
            {riskyAllowed.length > 0 && <span className="ml-1 text-destructive">· allows {riskyAllowed.length} risky capabilit{riskyAllowed.length === 1 ? "y" : "ies"}</span>}
          </p>
          <div className="flex gap-2">
            <Button variant="outline" disabled={!changes.length} onClick={() => setDraft({})}>
              Discard
            </Button>
            <Button disabled={!changes.length || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? "Saving…" : "Save permissions"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function RolesAdmin() {
  const qc = useQueryClient();
  const roles = useQuery({ queryKey: rolesKey, queryFn: () => api<Role[]>("/roles") });
  const capabilities = useQuery({ queryKey: ["capabilities"], queryFn: () => api<CapabilityDef[]>("/capabilities"), staleTime: Infinity });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Role | null>(null);
  const selected = roles.data?.find((r) => r.id === selectedId) ?? roles.data?.[0];

  const remove = useMutation({
    mutationFn: (id: string) => api(`/roles/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Role deleted");
      setDeleting(null);
      setSelectedId(null);
      void qc.invalidateQueries({ queryKey: rolesKey });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <RequireCapability capability="role:manage">
      <PageHeader
        title="Roles & permissions"
        description="Default permissions of each role across the organization. Course-level overrides are set per course."
        actions={
          <Button onClick={() => setCreating(true)} disabled={!roles.data}>
            <Plus /> New role
          </Button>
        }
      />
      <QueryState query={roles}>
        {roles.data && selected && (
          <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
            <nav aria-label="Roles">
              <label className="mb-2 block lg:hidden">
                <span className="sr-only">Role</span>
                <NativeSelect value={selected.id} onChange={(e) => setSelectedId(e.target.value)}>
                  {roles.data.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </NativeSelect>
              </label>
              <ul className="hidden space-y-1 lg:block">
                {roles.data.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(r.id)}
                      aria-current={r.id === selected.id ? "true" : undefined}
                      className={cn("w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-muted", r.id === selected.id && "bg-muted font-medium")}
                    >
                      {r.name}
                      <span className="block text-xs text-muted-foreground">{r.shortname}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
            <Card>
              <CardHeader className="flex flex-row items-start justify-between gap-2">
                <div className="min-w-0">
                  <CardTitle>{selected.name}</CardTitle>
                  <CardDescription>
                    Archetype <code>{selected.archetype}</code> · assignable at {selected.assignableLevels.join(", ") || "—"}
                    {selected.description && <span className="block">{selected.description}</span>}
                  </CardDescription>
                </div>
                {selected.shortname !== selected.archetype && (
                  <Button variant="ghost" size="icon-sm" aria-label={`Delete ${selected.name}`} onClick={() => setDeleting(selected)}>
                    <Trash2 />
                  </Button>
                )}
              </CardHeader>
              <CardContent>
                <QueryState query={capabilities}>{capabilities.data && <CapabilityMatrix key={selected.id} role={selected} capabilities={capabilities.data} />}</QueryState>
              </CardContent>
            </Card>
          </div>
        )}
      </QueryState>
      {creating && roles.data && <CreateRoleDialog roles={roles.data} open onOpenChange={setCreating} onCreated={(r) => setSelectedId(r.id)} />}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete ${deleting?.name}?`}
        description="Everyone holding this role loses it in every context."
        confirmLabel="Delete role"
        destructive
        confirmText={deleting?.shortname}
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </RequireCapability>
  );
}
