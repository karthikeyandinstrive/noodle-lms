"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Award, CheckCircle2, Circle, Download, ExternalLink, ShieldOff } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { EmptyState, formatDate, fullName, QueryState } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, errorMessage } from "@/lib/api";
import { useSession } from "@/lib/session";
import type { ActivityTypeUI, ActivityViewProps, SettingsFieldsProps } from "../activities/types";
import { ConfirmButton, NativeSelectClass, StatusBadge } from "./shared";
import { certificateDownloadUrl, verifyPath, type CertificateStatus, type IssuedListRow } from "./types";

const statusKey = (id: string) => ["certificate", id, "status"] as const;
const issuedKey = (id: string) => ["certificate", id, "issued"] as const;

function Requirement({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-sm">
      {ok ? <CheckCircle2 className="mt-0.5 size-4 text-emerald-600" aria-hidden /> : <Circle className="mt-0.5 size-4 text-muted-foreground" aria-hidden />}
      <span>
        {children}
        <span className="sr-only">{ok ? " (met)" : " (not met yet)"}</span>
      </span>
    </li>
  );
}

function MyCertificate({ activity }: ActivityViewProps) {
  const qc = useQueryClient();
  const s = activity.settings ?? {};
  const q = useQuery({ queryKey: statusKey(activity.id), queryFn: () => api<CertificateStatus>(`/certificates/${activity.id}/status`) });
  const claim = useMutation({
    mutationFn: () => api(`/certificates/${activity.id}/issue`, { body: {} }),
    onSuccess: () => {
      toast.success("Your certificate is ready");
      void qc.invalidateQueries({ queryKey: statusKey(activity.id) });
      void qc.invalidateQueries({ queryKey: ["certificates", "me"] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <QueryState query={q}>
      {q.data &&
        (() => {
          const d = q.data;
          const c = d.certificate;
          if (c) {
            return (
              <Card>
                <CardHeader>
                  <CardTitle className="flex flex-wrap items-center gap-2">
                    <Award className="size-5 text-primary" aria-hidden /> Your certificate <StatusBadge status={c.status} />
                  </CardTitle>
                  <CardDescription>
                    Issued {formatDate(c.issuedAt, false)}
                    {c.expiresAt && <> · {c.status === "expired" ? "expired" : "expires"} {formatDate(c.expiresAt, false)}</>} · Code{" "}
                    <span className="font-mono">{c.code}</span>
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-wrap gap-2">
                  {c.status !== "revoked" && c.hasFile && (
                    <Button render={<a href={certificateDownloadUrl(c.id)} />}>
                      <Download /> Download PDF
                    </Button>
                  )}
                  <Button variant="outline" render={<Link href={verifyPath(c.code)} target="_blank" rel="noopener" />}>
                    Verification page <ExternalLink />
                  </Button>
                  {c.status === "revoked" && <p className="w-full text-sm text-destructive">This certificate was revoked. Contact your teacher for details.</p>}
                </CardContent>
              </Card>
            );
          }
          return (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Award className="size-5 text-primary" aria-hidden /> Earn this certificate
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <ul className="space-y-2">
                  {s.requireCourseCompletion !== false && <Requirement ok={d.courseCompleted}>Complete the course</Requirement>}
                  {typeof s.minGradePercent === "number" && s.minGradePercent > 0 && (
                    <Requirement ok={d.gradePercent !== null && d.gradePercent >= s.minGradePercent}>
                      Reach a course grade of {s.minGradePercent}%{d.gradePercent !== null && <> (currently {Math.round(d.gradePercent * 10) / 10}%)</>}
                    </Requirement>
                  )}
                  {s.requireCourseCompletion === false && !(typeof s.minGradePercent === "number" && s.minGradePercent > 0) && (
                    <Requirement ok>No requirements — claim it any time</Requirement>
                  )}
                </ul>
                {!d.enrolled ? (
                  <p className="text-sm text-muted-foreground">Only enrolled learners can receive this certificate.</p>
                ) : d.eligible ? (
                  <Button onClick={() => claim.mutate()} disabled={claim.isPending}>
                    <Award /> {claim.isPending ? "Generating…" : "Get my certificate"}
                  </Button>
                ) : (
                  <p className="text-sm text-muted-foreground">{d.reasons.join(" ")}</p>
                )}
              </CardContent>
            </Card>
          );
        })()}
    </QueryState>
  );
}

function IssuedList({ activity }: ActivityViewProps) {
  const qc = useQueryClient();
  const canIssue = activity.capabilities["certificate:issue"] === true;
  const [filter, setFilter] = useState("");
  const q = useQuery({ queryKey: issuedKey(activity.id), queryFn: () => api<IssuedListRow[]>(`/certificates/${activity.id}/issued`) });
  const refresh = () => void qc.invalidateQueries({ queryKey: issuedKey(activity.id) });
  const issue = useMutation({
    mutationFn: (userId: string) => api(`/certificates/${activity.id}/issue/${userId}`, { body: {} }),
    onSuccess: () => {
      toast.success("Certificate issued");
      refresh();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const rows = (q.data ?? []).filter((r) => !filter || `${fullName(r.user)} ${r.user.email ?? ""}`.toLowerCase().includes(filter.toLowerCase()));
  const issuedCount = (q.data ?? []).filter((r) => r.certificate && r.certificate.status === "valid").length;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Issued certificates</CardTitle>
        {q.data && (
          <CardDescription>
            {issuedCount} of {q.data.length} learners hold a valid certificate
          </CardDescription>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <Input placeholder="Filter learners…" aria-label="Filter learners" value={filter} onChange={(e) => setFilter(e.target.value)} className="sm:max-w-xs" />
        <QueryState query={q}>
          {q.data && !q.data.length && <EmptyState title="No learners enrolled" />}
          {rows.length > 0 && (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Learner</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Issued</TableHead>
                    <TableHead>Code</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map(({ user, certificate: c }) => (
                    <TableRow key={user.id}>
                      <TableCell>
                        <div className="font-medium">{fullName(user)}</div>
                        {user.email && <div className="text-xs text-muted-foreground">{user.email}</div>}
                      </TableCell>
                      <TableCell>{c ? <StatusBadge status={c.status} /> : <span className="text-sm text-muted-foreground">Not issued</span>}</TableCell>
                      <TableCell>{c ? formatDate(c.issuedAt, false) : "—"}</TableCell>
                      <TableCell className="font-mono text-xs">{c?.code ?? "—"}</TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-1">
                          {c?.hasFile && (
                            <Button variant="ghost" size="icon-sm" aria-label={`Download certificate of ${fullName(user)}`} render={<a href={certificateDownloadUrl(c.id)} />}>
                              <Download />
                            </Button>
                          )}
                          {canIssue && (!c || c.status === "revoked") && (
                            <Button size="sm" variant="outline" disabled={issue.isPending} onClick={() => issue.mutate(user.id)}>
                              {c ? "Reinstate" : "Issue"}
                            </Button>
                          )}
                          {canIssue && c && c.status !== "revoked" && (
                            <ConfirmButton
                              title={`Revoke ${fullName(user)}'s certificate?`}
                              description="The verification page will show it as revoked and the learner can no longer download it."
                              confirmLabel="Revoke"
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`Revoke certificate of ${fullName(user)}`}
                              onConfirm={async () => {
                                try {
                                  await api(`/certificates/issued/${c.id}/revoke`, { body: {} });
                                  toast.success("Certificate revoked");
                                  refresh();
                                } catch (err) {
                                  toast.error(errorMessage(err));
                                }
                              }}
                            >
                              <ShieldOff />
                            </ConfirmButton>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </QueryState>
      </CardContent>
    </Card>
  );
}

function View(props: ActivityViewProps) {
  const staff = props.activity.capabilities["certificate:view_issued"] === true;
  return (
    <div className="space-y-4">
      {!staff && <MyCertificate {...props} />}
      {staff && (
        <Card size="sm">
          <CardContent className="text-sm text-muted-foreground">
            Template: <span className="font-medium text-foreground">{String(props.activity.settings?.templateName ?? "—")}</span>
            {props.activity.settings?.autoIssue ? " · issued automatically on course completion" : " · learners claim it when eligible"}
            {typeof props.activity.settings?.expiresAfterDays === "number" && <> · valid for {String(props.activity.settings.expiresAfterDays)} days</>}
          </CardContent>
        </Card>
      )}
      {staff && <IssuedList {...props} />}
    </div>
  );
}

function SettingsFields({ value, onChange }: SettingsFieldsProps) {
  const session = useSession();
  const templates = useQuery({
    queryKey: ["certificates", "templates", "options"],
    queryFn: () => api<{ id: string; name: string; orientation: string }[]>("/certificates/templates/options"),
  });
  const set = (k: string, v: unknown) => onChange({ ...value, [k]: v });
  const numOrNull = (v: string) => (v === "" ? null : Math.round(Number(v)));
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="cert-template">Template</Label>
        <QueryState query={templates}>
          {templates.data && !templates.data.length ? (
            <p className="text-sm text-muted-foreground">
              No templates yet.{" "}
              {session.can("certificate:manage_templates") ? (
                <Link href="/admin/certificates/new" className="text-primary underline">
                  Create one
                </Link>
              ) : (
                "Ask an administrator to create one."
              )}
            </p>
          ) : (
            <select id="cert-template" required className={NativeSelectClass} value={(value.templateId as string) ?? ""} onChange={(e) => set("templateId", e.target.value)}>
              <option value="" disabled>
                Choose a template…
              </option>
              {templates.data?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.orientation})
                </option>
              ))}
            </select>
          )}
        </QueryState>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <Switch checked={value.requireCourseCompletion !== false} onCheckedChange={(c) => set("requireCourseCompletion", c)} /> Require course completion
      </label>
      <label className="flex items-center gap-2 text-sm">
        <Switch checked={value.autoIssue !== false} onCheckedChange={(c) => set("autoIssue", c)} /> Issue automatically when the course is completed
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="cert-grade">Minimum course grade (%)</Label>
          <Input
            id="cert-grade"
            type="number"
            min={0}
            max={100}
            placeholder="No minimum"
            value={value.minGradePercent == null ? "" : String(value.minGradePercent)}
            onChange={(e) => set("minGradePercent", numOrNull(e.target.value))}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cert-expiry">Valid for (days)</Label>
          <Input
            id="cert-expiry"
            type="number"
            min={1}
            placeholder="Never expires"
            value={value.expiresAfterDays == null ? "" : String(value.expiresAfterDays)}
            onChange={(e) => set("expiresAfterDays", numOrNull(e.target.value))}
          />
        </div>
      </div>
    </div>
  );
}

export const certificateActivity: ActivityTypeUI = {
  type: "certificate",
  label: "Certificate",
  description: "Issue a PDF certificate on completion",
  icon: Award,
  defaults: { templateId: "", requireCourseCompletion: true, autoIssue: true, minGradePercent: null, expiresAfterDays: null },
  View,
  SettingsFields,
};
