"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search, Upload, UserPlus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorAlert, PageHeader, QueryState, formatDate, fullName } from "@/components/common";
import { api, errorMessage, type Paged } from "@/lib/api";
import { useSession } from "@/lib/session";
import { parseUserCsv, type ImportParse } from "./csv";
import { Field, NativeSelect, Pager, RequireCapability, useDebounced } from "./shared";
import type { AdminUser, UserStatus } from "./types";

export const usersKey = ["admin", "users"] as const;

export function StatusBadge({ status }: { status: UserStatus }) {
  if (status === "active") return <Badge variant="secondary">Active</Badge>;
  if (status === "suspended") return <Badge variant="destructive">Suspended</Badge>;
  return <Badge variant="outline">Invited</Badge>;
}

function CreateUserDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [v, setV] = useState({ email: "", firstName: "", lastName: "", password: "", mode: "invite" as "invite" | "password" });
  const [error, setError] = useState<unknown>(null);
  const create = useMutation({
    mutationFn: () =>
      api<AdminUser>("/users", {
        body: {
          email: v.email,
          firstName: v.firstName,
          lastName: v.lastName,
          ...(v.mode === "password" ? { password: v.password, sendInvite: false } : { sendInvite: true }),
        },
      }),
    onSuccess: (u) => {
      toast.success(v.mode === "invite" ? `Invitation sent to ${u.email}` : `${fullName(u)} created`);
      void qc.invalidateQueries({ queryKey: usersKey });
      setV({ email: "", firstName: "", lastName: "", password: "", mode: "invite" });
      onOpenChange(false);
    },
    onError: setError,
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add user</DialogTitle>
          <DialogDescription>Invite by email, or set an initial password yourself.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            create.mutate();
          }}
        >
          {error ? <ErrorAlert error={error} /> : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id="nu-first" label="First name">
              <Input id="nu-first" required maxLength={100} autoComplete="off" value={v.firstName} onChange={(e) => setV({ ...v, firstName: e.target.value })} />
            </Field>
            <Field id="nu-last" label="Last name">
              <Input id="nu-last" required maxLength={100} autoComplete="off" value={v.lastName} onChange={(e) => setV({ ...v, lastName: e.target.value })} />
            </Field>
          </div>
          <Field id="nu-email" label="Email">
            <Input id="nu-email" type="email" required maxLength={320} autoComplete="off" value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} />
          </Field>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Access</legend>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="nu-mode" checked={v.mode === "invite"} onChange={() => setV({ ...v, mode: "invite" })} /> Email an invitation link
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="nu-mode" checked={v.mode === "password"} onChange={() => setV({ ...v, mode: "password" })} /> Set a password now
            </label>
          </fieldset>
          {v.mode === "password" && (
            <Field id="nu-pass" label="Password" hint="At least 10 characters.">
              <Input id="nu-pass" type="password" required minLength={10} maxLength={200} autoComplete="new-password" value={v.password} onChange={(e) => setV({ ...v, password: e.target.value })} />
            </Field>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? "Creating…" : "Create user"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ImportUsersDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [parsed, setParsed] = useState<ImportParse | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: () => api<{ created: number; skipped: string[] }>("/users/import", { body: { rows: parsed!.rows } }),
    onSuccess: (r) => {
      toast.success(`${r.created} user${r.created === 1 ? "" : "s"} invited${r.skipped.length ? `, ${r.skipped.length} already existed` : ""}`);
      void qc.invalidateQueries({ queryKey: usersKey });
      setParsed(null);
      setFileName(null);
      onOpenChange(false);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import users from CSV</DialogTitle>
          <DialogDescription>
            Columns: <code>email,firstName,lastName</code> (header row optional). Each new user receives an invitation email; existing emails are skipped.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field id="csv-file" label="CSV file">
            <Input
              id="csv-file"
              type="file"
              accept=".csv,text/csv"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                if (file.size > 2 * 1024 * 1024) {
                  toast.error("The file is larger than 2 MB");
                  return;
                }
                setFileName(file.name);
                setParsed(parseUserCsv(await file.text()));
              }}
            />
          </Field>
          {parsed && (
            <div className="space-y-2 text-sm" aria-live="polite">
              <p>
                <strong>{parsed.rows.length}</strong> valid row{parsed.rows.length === 1 ? "" : "s"} in {fileName}
                {parsed.errors.length > 0 && <>, {parsed.errors.length} problem{parsed.errors.length === 1 ? "" : "s"}</>}
              </p>
              {parsed.errors.length > 0 && (
                <ul className="max-h-32 list-disc overflow-auto rounded-md border bg-muted/40 p-2 pl-6 text-xs text-destructive">
                  {parsed.errors.slice(0, 50).map((err) => (
                    <li key={err}>{err}</li>
                  ))}
                </ul>
              )}
              {parsed.rows.length > 0 && (
                <div className="max-h-48 overflow-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Email</TableHead>
                        <TableHead>Name</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {parsed.rows.slice(0, 20).map((r) => (
                        <TableRow key={r.email}>
                          <TableCell className="max-w-48 truncate">{r.email}</TableCell>
                          <TableCell>{fullName(r)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  {parsed.rows.length > 20 && <p className="p-2 text-xs text-muted-foreground">…and {parsed.rows.length - 20} more</p>}
                </div>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!parsed?.rows.length || run.isPending} onClick={() => run.mutate()}>
            {run.isPending ? "Importing…" : `Import ${parsed?.rows.length ?? 0} users`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function UsersAdmin() {
  const session = useSession();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"" | UserStatus>("");
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const q = useDebounced(search.trim());
  const users = useQuery({
    queryKey: [...usersKey, { q, status, page }],
    queryFn: () => api<Paged<AdminUser>>("/users", { query: { search: q, status, page, pageSize: 25 } }),
    placeholderData: keepPreviousData,
  });
  const canManage = session.can("user:manage");

  return (
    <RequireCapability capability="user:view">
      <PageHeader
        title="Users"
        description="Everyone with an account in this organization."
        actions={
          canManage && (
            <>
              <Button variant="outline" onClick={() => setImporting(true)}>
                <Upload /> Import CSV
              </Button>
              <Button onClick={() => setCreating(true)}>
                <UserPlus /> Add user
              </Button>
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
            placeholder="Search name or email"
            aria-label="Search users"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <NativeSelect
          className="sm:w-44"
          aria-label="Filter by status"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as "" | UserStatus);
            setPage(1);
          }}
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="pending">Invited</option>
          <option value="suspended">Suspended</option>
        </NativeSelect>
      </div>
      <QueryState query={users}>
        {users.data && users.data.items.length === 0 ? (
          <EmptyState title="No users found" description={q || status ? "Try a different search or filter." : undefined} />
        ) : (
          users.data && (
            <>
              <div className="overflow-x-auto rounded-xl border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead className="hidden md:table-cell">Email</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="hidden lg:table-cell">Last sign-in</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {users.data.items.map((u) => (
                      <TableRow key={u.id}>
                        <TableCell>
                          <Link href={`/admin/users/${u.id}`} className="font-medium hover:underline">
                            {fullName(u)}
                          </Link>
                          <div className="truncate text-xs text-muted-foreground md:hidden">{u.email}</div>
                        </TableCell>
                        <TableCell className="hidden max-w-64 truncate md:table-cell">{u.email}</TableCell>
                        <TableCell>
                          <StatusBadge status={u.status} />
                        </TableCell>
                        <TableCell className="hidden text-muted-foreground lg:table-cell">{formatDate(u.lastLoginAt)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <Pager page={users.data.page} pageSize={users.data.pageSize} total={users.data.total} onPage={setPage} />
            </>
          )
        )}
      </QueryState>
      {canManage && (
        <>
          <CreateUserDialog open={creating} onOpenChange={setCreating} />
          <ImportUsersDialog open={importing} onOpenChange={setImporting} />
        </>
      )}
    </RequireCapability>
  );
}
