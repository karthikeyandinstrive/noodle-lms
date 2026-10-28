"use client";

import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, ShieldAlert, XCircle } from "lucide-react";
import { useParams } from "next/navigation";
import { formatDate } from "@/components/common";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { BadgeImage } from "@/features/badges/badge-image";
import { assertionUrl } from "@/features/badges/types";
import { api, ApiError } from "@/lib/api";

type Summary = {
  badgeId: string;
  badgeName: string;
  description: string;
  criteria: string;
  hasImage: boolean;
  recipientName: string;
  courseName: string | null;
  issuerName: string;
  issuedAt: string;
  expiresAt: string | null;
  status: "valid" | "revoked" | "expired";
};

const HASH = /^[A-Za-z0-9_-]{16,64}$/;

/** Public (signed-out) badge page: what the badge is, who earned it, and its Open Badges assertion. */
export default function PublicBadgePage() {
  const { hash } = useParams<{ hash: string }>();
  const valid = HASH.test(hash ?? "");
  const q = useQuery({
    queryKey: ["badge-assertion", hash],
    queryFn: () => api<Summary>(`/badges/assertions/${hash}/summary`),
    enabled: valid,
    retry: false,
  });
  const notFound = !valid || (q.error instanceof ApiError && q.error.status < 500);

  return (
    <main className="mx-auto flex min-h-svh max-w-xl flex-col justify-center gap-6 px-4 py-10">
      <h1 className="text-center text-2xl font-semibold tracking-tight">Badge verification</h1>
      <Card>
        <CardContent aria-live="polite">
          {valid && q.isPending && (
            <div className="space-y-3" aria-busy="true">
              <Skeleton className="mx-auto size-24 rounded-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          )}
          {notFound && (
            <div className="flex items-start gap-3">
              <XCircle className="size-6 shrink-0 text-destructive" aria-hidden />
              <p className="font-medium">This badge could not be found.</p>
            </div>
          )}
          {q.isError && !notFound && <p className="text-sm text-destructive">Verification is temporarily unavailable.</p>}
          {q.data && (
            <div className="space-y-5 text-center">
              <BadgeImage badgeId={q.data.badgeId} hasImage={q.data.hasImage} muted={q.data.status !== "valid"} className="mx-auto size-28" />
              <div>
                <p className="text-xl font-semibold">{q.data.badgeName}</p>
                <p className="mt-1 text-sm text-muted-foreground">{q.data.description}</p>
              </div>
              <p className="flex items-center justify-center gap-2 text-sm font-medium">
                {q.data.status === "valid" ? (
                  <>
                    <CheckCircle2 className="size-5 text-emerald-600" aria-hidden /> Earned by {q.data.recipientName}
                  </>
                ) : (
                  <>
                    <ShieldAlert className="size-5 text-destructive" aria-hidden />
                    {q.data.status === "revoked" ? "This badge was revoked" : `This badge expired ${formatDate(q.data.expiresAt, false)}`}
                  </>
                )}
              </p>
              <dl className="grid gap-3 text-left text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-muted-foreground">Issuer</dt>
                  <dd className="font-medium">{q.data.issuerName}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Issued</dt>
                  <dd className="font-medium">{formatDate(q.data.issuedAt, false)}</dd>
                </div>
                {q.data.courseName && (
                  <div>
                    <dt className="text-muted-foreground">Course</dt>
                    <dd className="font-medium">{q.data.courseName}</dd>
                  </div>
                )}
                <div className="sm:col-span-2">
                  <dt className="text-muted-foreground">Criteria</dt>
                  <dd>{q.data.criteria}</dd>
                </div>
              </dl>
              {q.data.status !== "revoked" && (
                <a href={assertionUrl(hash)} className="inline-block text-sm text-primary underline" target="_blank" rel="noopener">
                  Open Badges 2.0 assertion (JSON)
                </a>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
