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
import { EmptyState, ErrorAlert, PageHeader, QueryState, fullName } from "@/components/common";
import { api, errorMessage, type Paged } from "@/lib/api";
import { useFormat, useT } from "@/lib/i18n";
import { useSession } from "@/lib/session";
import { parseUserCsv, type ImportParse } from "./csv";
import { Field, NativeSelect, Pager, RequireCapability, useDebounced } from "./shared";
import type { AdminUser, UserStatus } from "./types";

export const usersKey = ["admin", "users"] as const;

export function StatusBadge({ status }: { status: UserStatus }) {
  const t = useT();
  if (status === "active") return <Badge variant="secondary">{t("admin.users.status.active", "Active")}</Badge>;
  if (status === "suspended") return <Badge variant="destructive">{t("admin.shared.suspended", "Suspended")}</Badge>;
  return <Badge variant="outline">{t("admin.users.status.invited", "Invited")}</Badge>;
}

function CreateUserDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const t = useT();
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
      toast.success(v.mode === "invite" ? t("admin.users.invitationSent", "Invitation sent to {email}", { email: u.email }) : t("admin.shared.created", "{name} created", { name: fullName(u) }));
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
          <DialogTitle>{t("admin.users.addUser", "Add user")}</DialogTitle>
          <DialogDescription>{t("admin.users.addUserDescription", "Invite by email, or set an initial password yourself.")}</DialogDescription>
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
            <Field id="nu-first" label={t("admin.shared.firstName", "First name")}>
              <Input id="nu-first" required maxLength={100} autoComplete="off" value={v.firstName} onChange={(e) => setV({ ...v, firstName: e.target.value })} />
            </Field>
            <Field id="nu-last" label={t("admin.shared.lastName", "Last name")}>
              <Input id="nu-last" required maxLength={100} autoComplete="off" value={v.lastName} onChange={(e) => setV({ ...v, lastName: e.target.value })} />
            </Field>
          </div>
          <Field id="nu-email" label={t("common.email", "Email")}>
            <Input id="nu-email" type="email" required maxLength={320} autoComplete="off" value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} />
          </Field>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t("admin.users.access", "Access")}</legend>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="nu-mode" checked={v.mode === "invite"} onChange={() => setV({ ...v, mode: "invite" })} /> {t("admin.users.modeInvite", "Email an invitation link")}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="nu-mode" checked={v.mode === "password"} onChange={() => setV({ ...v, mode: "password" })} /> {t("admin.users.modePassword", "Set a password now")}
            </label>
          </fieldset>
          {v.mode === "password" && (
            <Field id="nu-pass" label={t("admin.users.password", "Password")} hint={t("admin.shared.passwordHint", "At least 10 characters.")}>
              <Input id="nu-pass" type="password" required minLength={10} maxLength={200} autoComplete="new-password" value={v.password} onChange={(e) => setV({ ...v, password: e.target.value })} />
            </Field>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("common.cancel", "Cancel")}
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? t("admin.shared.creating", "Creating…") : t("admin.users.createUser", "Create user")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ImportUsersDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [parsed, setParsed] = useState<ImportParse | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: () => api<{ created: number; skipped: string[] }>("/users/import", { body: { rows: parsed!.rows } }),
    onSuccess: (r) => {
      const invited = r.created === 1 ? t("admin.users.import.invited.one", "1 user invited") : t("admin.users.import.invited.other", "{count} users invited", { count: r.created });
      toast.success(r.skipped.length ? t("admin.users.import.invitedSkipped", "{invited}, {skipped} already existed", { invited, skipped: r.skipped.length }) : invited);
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
          <DialogTitle>{t("admin.users.import.title", "Import users from CSV")}</DialogTitle>
          <DialogDescription>
            {t("admin.users.import.columns", "Columns:")} <code>email,firstName,lastName</code>{" "}
            {t("admin.users.import.help", "(header row optional). Each new user receives an invitation email; existing emails are skipped.")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field id="csv-file" label={t("admin.users.import.csvFile", "CSV file")}>
            <Input
              id="csv-file"
              type="file"
              accept=".csv,text/csv"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                if (file.size > 2 * 1024 * 1024) {
                  toast.error(t("admin.users.import.tooLarge", "The file is larger than 2 MB"));
                  return;
                }
                setFileName(file.name);
                setParsed(parseUserCsv(await file.text(), t));
              }}
            />
          </Field>
          {parsed && (
            <div className="space-y-2 text-sm">
              <p role="status">
                {parsed.rows.length === 1
                  ? t("admin.users.import.validRows.one", "1 valid row in {file}", { file: fileName ?? "" })
                  : t("admin.users.import.validRows.other", "{count} valid rows in {file}", { count: parsed.rows.length, file: fileName ?? "" })}
                {parsed.errors.length > 0 &&
                  (parsed.errors.length === 1
                    ? t("admin.users.import.problems.one", ", 1 problem")
                    : t("admin.users.import.problems.other", ", {count} problems", { count: parsed.errors.length }))}
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
                  <Table aria-label={t("admin.users.import.preview", "Import preview")}>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("common.email", "Email")}</TableHead>
                        <TableHead>{t("common.name", "Name")}</TableHead>
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
                  {parsed.rows.length > 20 && <p className="p-2 text-xs text-muted-foreground">{t("admin.users.import.more", "…and {count} more", { count: parsed.rows.length - 20 })}</p>}
                </div>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel", "Cancel")}
          </Button>
          <Button disabled={!parsed?.rows.length || run.isPending} onClick={() => run.mutate()}>
            {run.isPending ? t("admin.users.import.importing", "Importing…") : t("admin.users.import.submit", "Import {count} users", { count: parsed?.rows.length ?? 0 })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function UsersAdmin() {
  const t = useT();
  const fmt = useFormat();
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
        title={t("admin.users.title", "Users")}
        description={t("admin.users.description", "Everyone with an account in this organization.")}
        actions={
          canManage && (
            <>
              <Button variant="outline" onClick={() => setImporting(true)}>
                <Upload aria-hidden /> {t("admin.users.importCsv", "Import CSV")}
              </Button>
              <Button onClick={() => setCreating(true)}>
                <UserPlus aria-hidden /> {t("admin.users.addUser", "Add user")}
              </Button>
            </>
          )
        }
      />
      <div className="mb-4 flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-8"
            type="search"
            placeholder={t("admin.users.searchPlaceholder", "Search name or email")}
            aria-label={t("admin.shared.searchUsers", "Search users")}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <NativeSelect
          className="sm:w-44"
          aria-label={t("admin.users.filterStatus", "Filter by status")}
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as "" | UserStatus);
            setPage(1);
          }}
        >
          <option value="">{t("admin.users.allStatuses", "All statuses")}</option>
          <option value="active">{t("admin.users.status.active", "Active")}</option>
          <option value="pending">{t("admin.users.status.invited", "Invited")}</option>
          <option value="suspended">{t("admin.shared.suspended", "Suspended")}</option>
        </NativeSelect>
      </div>
      <QueryState query={users}>
        {users.data && users.data.items.length === 0 ? (
          <EmptyState title={t("admin.users.noneFound", "No users found")} description={q || status ? t("admin.shared.tryDifferentFilter", "Try a different search or filter.") : undefined} />
        ) : (
          users.data && (
            <>
              <div className="overflow-x-auto rounded-xl border">
                <Table aria-label={t("admin.users.title", "Users")}>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("common.name", "Name")}</TableHead>
                      <TableHead className="hidden md:table-cell">{t("common.email", "Email")}</TableHead>
                      <TableHead>{t("common.status", "Status")}</TableHead>
                      <TableHead className="hidden lg:table-cell">{t("admin.shared.lastSignIn", "Last sign-in")}</TableHead>
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
                        <TableCell className="hidden text-muted-foreground lg:table-cell">{fmt.date(u.lastLoginAt)}</TableCell>
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
