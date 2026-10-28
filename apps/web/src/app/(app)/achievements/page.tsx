"use client";

import { useQuery } from "@tanstack/react-query";
import { Award, Copy, Download, ExternalLink } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { EmptyState, formatDate, PageHeader, QueryState } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { BadgeImage } from "@/features/badges/badge-image";
import { assertionUrl, badgePagePath, type MyBadge } from "@/features/badges/types";
import { StatusBadge } from "@/features/certificate/shared";
import { certificateDownloadUrl, verifyPath, type MyCertificate } from "@/features/certificate/types";
import { api } from "@/lib/api";

async function copyLink(path: string) {
  const url = `${window.location.origin}${path}`;
  try {
    await navigator.clipboard.writeText(url);
    toast.success("Link copied");
  } catch {
    toast.message(url);
  }
}

function Certificates() {
  const q = useQuery({ queryKey: ["certificates", "me"], queryFn: () => api<MyCertificate[]>("/certificates/me") });
  return (
    <QueryState query={q}>
      {q.data && !q.data.length && <EmptyState title="No certificates yet" description="Certificates appear here when you complete courses that award them." />}
      {q.data && q.data.length > 0 && (
        <ul className="grid gap-3 md:grid-cols-2">
          {q.data.map((c) => (
            <li key={c.id}>
              <Card className="h-full">
                <CardContent className="flex h-full flex-col gap-3">
                  <div className="flex items-start gap-3">
                    <Award className="mt-0.5 size-6 shrink-0 text-primary" aria-hidden />
                    <div className="min-w-0">
                      <p className="font-medium">{c.activityName}</p>
                      <p className="text-sm text-muted-foreground">
                        <Link href={`/courses/${c.courseId}`} className="hover:underline">
                          {c.courseName}
                        </Link>
                      </p>
                      <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <StatusBadge status={c.status} /> Issued {formatDate(c.issuedAt, false)}
                        {c.expiresAt && <> · expires {formatDate(c.expiresAt, false)}</>}
                      </p>
                      <p className="mt-1 font-mono text-xs text-muted-foreground">{c.code}</p>
                    </div>
                  </div>
                  <div className="mt-auto flex flex-wrap gap-2">
                    {c.status !== "revoked" && c.hasFile && (
                      <Button size="sm" render={<a href={certificateDownloadUrl(c.id)} />}>
                        <Download /> Download
                      </Button>
                    )}
                    <Button size="sm" variant="outline" onClick={() => copyLink(verifyPath(c.code))}>
                      <Copy /> Copy verification link
                    </Button>
                    <Button size="sm" variant="ghost" render={<Link href={verifyPath(c.code)} target="_blank" rel="noopener" />}>
                      Verify <ExternalLink />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </QueryState>
  );
}

function Badges() {
  const q = useQuery({ queryKey: ["badges", "me"], queryFn: () => api<MyBadge[]>("/badges/me") });
  return (
    <QueryState query={q}>
      {q.data && !q.data.length && <EmptyState title="No badges yet" description="Earn badges by completing courses and activities." />}
      {q.data && q.data.length > 0 && (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {q.data.map((b) => (
            <li key={b.id}>
              <Card className="h-full">
                <CardContent className="flex h-full flex-col gap-3">
                  <div className="flex items-start gap-3">
                    <BadgeImage badgeId={b.badge.id} hasImage={!!b.badge.imageFileId} muted={b.status !== "valid"} className="size-14" />
                    <div className="min-w-0">
                      <p className="font-medium">{b.badge.name}</p>
                      <p className="text-xs text-muted-foreground">{b.courseName ?? "Site badge"}</p>
                      <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <StatusBadge status={b.status} /> {formatDate(b.issuedAt, false)}
                      </p>
                    </div>
                  </div>
                  <p className="line-clamp-3 text-sm text-muted-foreground">{b.badge.description}</p>
                  {b.status !== "revoked" && (
                    <div className="mt-auto flex flex-wrap gap-2">
                      <Button size="sm" variant="outline" onClick={() => copyLink(badgePagePath(b.uniqueHash))}>
                        <Copy /> Share link
                      </Button>
                      <Button size="sm" variant="ghost" render={<a href={assertionUrl(b.uniqueHash)} target="_blank" rel="noopener" />}>
                        Open Badges JSON <ExternalLink />
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </QueryState>
  );
}

export default function AchievementsPage() {
  return (
    <div className="space-y-8">
      <PageHeader title="Certificates & badges" description="Everything you have earned, ready to download or share." />
      <section aria-labelledby="my-certificates" className="space-y-3">
        <h2 id="my-certificates" className="text-lg font-semibold">
          Certificates
        </h2>
        <Certificates />
      </section>
      <section aria-labelledby="my-badges" className="space-y-3">
        <h2 id="my-badges" className="text-lg font-semibold">
          Badges
        </h2>
        <Badges />
      </section>
    </div>
  );
}
