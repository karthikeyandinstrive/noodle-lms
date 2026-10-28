"use client";

import { useQuery } from "@tanstack/react-query";
import { Award, Copy, Download, ExternalLink } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { EmptyState, PageHeader, QueryState } from "@/components/common";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { BadgeImage } from "@/features/badges/badge-image";
import { assertionUrl, badgePagePath, type MyBadge } from "@/features/badges/types";
import { StatusBadge } from "@/features/certificate/shared";
import { certificateDownloadUrl, verifyPath, type MyCertificate } from "@/features/certificate/types";
import { api } from "@/lib/api";
import { type Translate, useFormat, useT } from "@/lib/i18n";

async function copyLink(path: string, t: Translate) {
  const url = `${window.location.origin}${path}`;
  try {
    await navigator.clipboard.writeText(url);
    toast.success(t("achievements.linkCopied", "Link copied"));
  } catch {
    toast.message(url);
  }
}

function Certificates() {
  const t = useT();
  const fmt = useFormat();
  const q = useQuery({ queryKey: ["certificates", "me"], queryFn: () => api<MyCertificate[]>("/certificates/me") });
  return (
    <QueryState query={q}>
      {q.data && !q.data.length && <EmptyState
          title={t("achievements.noCertificates", "No certificates yet")}
          description={t("achievements.noCertificatesHint", "Certificates appear here when you complete courses that award them.")}
        />}
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
                        <StatusBadge status={c.status} /> {t("achievements.issued", "Issued {date}", { date: fmt.date(c.issuedAt, false) })}
                        {c.expiresAt && <> · {t("achievements.expires", "expires {date}", { date: fmt.date(c.expiresAt, false) })}</>}
                      </p>
                      <p className="mt-1 font-mono text-xs text-muted-foreground">{c.code}</p>
                    </div>
                  </div>
                  <div className="mt-auto flex flex-wrap gap-2">
                    {c.status !== "revoked" && c.hasFile && (
                      <a href={certificateDownloadUrl(c.id)} className={buttonVariants({ size: "sm" })}>
                        <Download aria-hidden /> {t("common.download", "Download")}
                      </a>
                    )}
                    <Button size="sm" variant="outline" onClick={() => copyLink(verifyPath(c.code), t)}>
                      <Copy aria-hidden /> {t("achievements.copyVerificationLink", "Copy verification link")}
                    </Button>
                    <Link href={verifyPath(c.code)} target="_blank" rel="noopener" className={buttonVariants({ size: "sm", variant: "ghost" })}>
                      {t("achievements.verify", "Verify")} <ExternalLink aria-hidden />
                      <span className="sr-only">{t("achievements.opensNewTab", "(opens in a new tab)")}</span>
                    </Link>
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
  const t = useT();
  const fmt = useFormat();
  const q = useQuery({ queryKey: ["badges", "me"], queryFn: () => api<MyBadge[]>("/badges/me") });
  return (
    <QueryState query={q}>
      {q.data && !q.data.length && <EmptyState title={t("achievements.noBadges", "No badges yet")} description={t("achievements.noBadgesHint", "Earn badges by completing courses and activities.")} />}
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
                      <p className="text-xs text-muted-foreground">{b.courseName ?? t("achievements.siteBadge", "Site badge")}</p>
                      <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <StatusBadge status={b.status} /> {fmt.date(b.issuedAt, false)}
                      </p>
                    </div>
                  </div>
                  <p className="line-clamp-3 text-sm text-muted-foreground">{b.badge.description}</p>
                  {b.status !== "revoked" && (
                    <div className="mt-auto flex flex-wrap gap-2">
                      <Button size="sm" variant="outline" onClick={() => copyLink(badgePagePath(b.uniqueHash), t)}>
                        <Copy aria-hidden /> {t("achievements.shareLink", "Share link")}
                      </Button>
                      <a href={assertionUrl(b.uniqueHash)} target="_blank" rel="noopener" className={buttonVariants({ size: "sm", variant: "ghost" })}>
                        {t("achievements.openBadgesJson", "Open Badges JSON")} <ExternalLink aria-hidden />
                        <span className="sr-only">{t("achievements.opensNewTab", "(opens in a new tab)")}</span>
                      </a>
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
  const t = useT();
  return (
    <div className="space-y-8">
      <PageHeader title={t("nav.achievements", "Certificates & badges")} description={t("achievements.description", "Everything you have earned, ready to download or share.")} />
      <section aria-labelledby="my-certificates" className="space-y-3">
        <h2 id="my-certificates" className="text-lg font-semibold">
          {t("achievements.certificates", "Certificates")}
        </h2>
        <Certificates />
      </section>
      <section aria-labelledby="my-badges" className="space-y-3">
        <h2 id="my-badges" className="text-lg font-semibold">
          {t("course.tab.badges", "Badges")}
        </h2>
        <Badges />
      </section>
    </div>
  );
}
