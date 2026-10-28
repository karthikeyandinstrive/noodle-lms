"use client";

import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, ShieldAlert, XCircle } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { formatDate } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { api, ApiError } from "@/lib/api";

type Verification = {
  code: string;
  status: "valid" | "revoked" | "expired";
  recipientName: string;
  courseName: string;
  certificateName: string;
  organizationName: string;
  issuedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
};

const CODE = /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

/** Public (signed-out) certificate verification page. */
export default function VerifyCertificatePage() {
  const params = useParams<{ code: string }>();
  const router = useRouter();
  const code = decodeURIComponent(params.code ?? "").trim().toUpperCase();
  const [input, setInput] = useState(code);
  const valid = CODE.test(code);
  const q = useQuery({
    queryKey: ["verify", code],
    queryFn: () => api<Verification>(`/certificates/verify/${encodeURIComponent(code)}`),
    enabled: valid,
    retry: false,
  });
  const notFound = !valid || (q.error instanceof ApiError && (q.error.status === 404 || q.error.status === 400));

  return (
    <main className="mx-auto flex min-h-svh max-w-xl flex-col justify-center gap-6 px-4 py-10">
      <h1 className="text-center text-2xl font-semibold tracking-tight">Certificate verification</h1>
      <Card>
        <CardContent className="pt-2" aria-live="polite">
          {valid && q.isPending && (
            <div className="space-y-3" aria-busy="true">
              <Skeleton className="h-6 w-1/2" />
              <Skeleton className="h-20 w-full" />
            </div>
          )}
          {notFound && (
            <div className="flex items-start gap-3">
              <XCircle className="size-6 shrink-0 text-destructive" aria-hidden />
              <div>
                <p className="font-medium">No certificate found</p>
                <p className="text-sm text-muted-foreground">Check the code and try again. Codes look like ABCD-EFGH-JKLM.</p>
              </div>
            </div>
          )}
          {q.isError && !notFound && <p className="text-sm text-destructive">Verification is temporarily unavailable. Please try again later.</p>}
          {q.data && (
            <div className="space-y-4">
              <div className="flex items-start gap-3">
                {q.data.status === "valid" ? (
                  <CheckCircle2 className="size-7 shrink-0 text-emerald-600" aria-hidden />
                ) : (
                  <ShieldAlert className="size-7 shrink-0 text-destructive" aria-hidden />
                )}
                <div>
                  <p className="text-lg font-semibold">
                    {q.data.status === "valid" ? "Valid certificate" : q.data.status === "expired" ? "This certificate has expired" : "This certificate was revoked"}
                  </p>
                  <p className="text-sm text-muted-foreground">Issued by {q.data.organizationName}</p>
                </div>
              </div>
              <dl className="grid gap-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-muted-foreground">Awarded to</dt>
                  <dd className="font-medium">{q.data.recipientName}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Course</dt>
                  <dd className="font-medium">{q.data.courseName}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Certificate</dt>
                  <dd className="font-medium">{q.data.certificateName}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Issued</dt>
                  <dd className="font-medium">{formatDate(q.data.issuedAt, false)}</dd>
                </div>
                {q.data.expiresAt && (
                  <div>
                    <dt className="text-muted-foreground">{q.data.status === "expired" ? "Expired" : "Expires"}</dt>
                    <dd className="font-medium">{formatDate(q.data.expiresAt, false)}</dd>
                  </div>
                )}
                {q.data.revokedAt && (
                  <div>
                    <dt className="text-muted-foreground">Revoked</dt>
                    <dd className="font-medium">{formatDate(q.data.revokedAt, false)}</dd>
                  </div>
                )}
                <div className="sm:col-span-2">
                  <dt className="text-muted-foreground">Verification code</dt>
                  <dd className="font-mono font-medium">{q.data.code}</dd>
                </div>
              </dl>
            </div>
          )}
        </CardContent>
      </Card>
      <Card size="sm">
        <CardHeader>
          <CardTitle className="text-base">Check another code</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-2 sm:flex-row sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              const next = input.trim().toUpperCase();
              if (next) router.push(`/verify/${encodeURIComponent(next)}`);
            }}
          >
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="verify-code">Verification code</Label>
              <Input id="verify-code" autoComplete="off" spellCheck={false} placeholder="ABCD-EFGH-JKLM" value={input} onChange={(e) => setInput(e.target.value)} />
            </div>
            <Button type="submit">Verify</Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
