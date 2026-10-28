"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Braces } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, PageHeader, QueryState, formatDate, fullName } from "@/components/common";
import { api, type Paged } from "@/lib/api";
import { Field, Pager, RequireCapability, useDebounced } from "./shared";
import type { AuditEntry } from "./types";

/** Renders JSON with keys sorted, for the metadata viewer. */
function JsonView({ value }: { value: unknown }) {
  return (
    <pre className="max-h-[60vh] overflow-auto rounded-lg bg-muted p-3 text-xs leading-relaxed break-all whitespace-pre-wrap">
      {JSON.stringify(value, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v), 2)}
    </pre>
  );
}

export function AuditLogAdmin() {
  const [action, setAction] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [viewing, setViewing] = useState<AuditEntry | null>(null);
  const a = useDebounced(action.trim());
  const logs = useQuery({
    queryKey: ["admin", "audit-log", { a, from, to, page }],
    queryFn: () =>
      api<Paged<AuditEntry>>("/audit-logs", {
        query: {
          action: a,
          // Date inputs are local calendar days: include the whole "to" day.
          from: from ? new Date(`${from}T00:00:00`).toISOString() : undefined,
          to: to ? new Date(`${to}T23:59:59.999`).toISOString() : undefined,
          page,
          pageSize: 50,
        },
      }),
    placeholderData: keepPreviousData,
  });
  const reset = (fn: () => void) => {
    fn();
    setPage(1);
  };

  return (
    <RequireCapability capability="site:view_audit_log">
      <PageHeader title="Audit log" description="Administrative and security-relevant changes, newest first." />
      <div className="mb-4 grid gap-3 sm:grid-cols-[1fr_auto_auto]">
        <Field id="al-action" label="Action" hint="Exact name, e.g. user.updated or payment.refunded">
          <Input id="al-action" value={action} onChange={(e) => reset(() => setAction(e.target.value))} placeholder="Any action" />
        </Field>
        <Field id="al-from" label="From">
          <Input id="al-from" type="date" value={from} onChange={(e) => reset(() => setFrom(e.target.value))} />
        </Field>
        <Field id="al-to" label="To">
          <Input id="al-to" type="date" value={to} onChange={(e) => reset(() => setTo(e.target.value))} />
        </Field>
      </div>
      <QueryState query={logs}>
        {logs.data && logs.data.items.length === 0 ? (
          <EmptyState title="No entries" description="Nothing matches these filters." />
        ) : (
          logs.data && (
            <>
              <div className="overflow-x-auto rounded-xl border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>When</TableHead>
                      <TableHead>Action</TableHead>
                      <TableHead className="hidden md:table-cell">Actor</TableHead>
                      <TableHead className="hidden lg:table-cell">Target</TableHead>
                      <TableHead className="hidden lg:table-cell">IP</TableHead>
                      <TableHead>
                        <span className="sr-only">Details</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {logs.data.items.map((e) => (
                      <TableRow key={e.id}>
                        <TableCell className="whitespace-nowrap text-muted-foreground">{formatDate(e.createdAt)}</TableCell>
                        <TableCell>
                          <code className="text-xs">{e.action}</code>
                          <div className="text-xs text-muted-foreground md:hidden">{e.actor ? fullName(e.actor) : "System"}</div>
                        </TableCell>
                        <TableCell className="hidden md:table-cell">{e.actor ? fullName(e.actor) : <span className="text-muted-foreground">System</span>}</TableCell>
                        <TableCell className="hidden max-w-56 truncate text-xs lg:table-cell">
                          {e.targetType ? (
                            <>
                              {e.targetType} <span className="font-mono text-muted-foreground">{e.targetId}</span>
                            </>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                        <TableCell className="hidden font-mono text-xs lg:table-cell">{e.ip ?? "—"}</TableCell>
                        <TableCell className="text-right">
                          <Button variant="ghost" size="icon-sm" aria-label={`View details of ${e.action}`} onClick={() => setViewing(e)}>
                            <Braces />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <Pager page={logs.data.page} pageSize={logs.data.pageSize} total={logs.data.total} onPage={setPage} />
            </>
          )
        )}
      </QueryState>
      <Dialog open={!!viewing} onOpenChange={(o) => !o && setViewing(null)}>
        <DialogContent className="sm:max-w-2xl">
          {viewing && (
            <>
              <DialogHeader>
                <DialogTitle className="font-mono text-base">{viewing.action}</DialogTitle>
                <DialogDescription>
                  {formatDate(viewing.createdAt)} · {viewing.actor ? fullName(viewing.actor) : "System"}
                  {viewing.ip && <> · {viewing.ip}</>}
                </DialogDescription>
              </DialogHeader>
              <JsonView value={{ target: viewing.targetType ? { type: viewing.targetType, id: viewing.targetId } : null, metadata: viewing.metadata }} />
            </>
          )}
        </DialogContent>
      </Dialog>
    </RequireCapability>
  );
}
