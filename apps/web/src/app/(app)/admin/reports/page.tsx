"use client";

import { EmptyState, PageHeader } from "@/components/common";
import { SiteOverview } from "@/features/reports/site-overview";
import { useSession } from "@/lib/session";
import { useT } from "@/lib/i18n";

export default function SiteReportsPage() {
  const session = useSession();
  const t = useT();
  if (!session.data) return null;
  if (!session.can("report:view_site")) return (
      <EmptyState
        title={t("adminPage.reports.unavailable", "Reports are not available")}
        description={t("adminPage.reports.noPermission", "You don't have permission to view site reports.")}
      />
    );
  return (
    <div>
      <PageHeader title={t("adminPage.reports.title", "Site reports")} description={t("adminPage.reports.description", "Usage across the whole organization.")} />
      <SiteOverview />
    </div>
  );
}
