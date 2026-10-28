"use client";

import { PageHeader } from "@/components/common";
import { BadgeManager } from "@/features/badges/badge-manager";
import { useSession } from "@/lib/session";
import { useT } from "@/lib/i18n";

export default function SiteBadgesPage() {
  const session = useSession();
  const t = useT();
  return (
    <div>
      <PageHeader title={t("nav.admin.badges", "Site badges")} description={t("adminPage.badges.description", "Badges that can be earned across the whole organization.")} />
      <BadgeManager courseId={null} canAward={session.can("badge:award") || session.can("badge:manage")} />
    </div>
  );
}
