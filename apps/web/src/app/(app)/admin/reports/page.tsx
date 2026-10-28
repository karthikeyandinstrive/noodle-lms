"use client";

import { EmptyState, PageHeader } from "@/components/common";
import { SiteOverview } from "@/features/reports/site-overview";
import { useSession } from "@/lib/session";

export default function SiteReportsPage() {
  const session = useSession();
  if (!session.data) return null;
  if (!session.can("report:view_site")) return <EmptyState title="Reports are not available" description="You don't have permission to view site reports." />;
  return (
    <div>
      <PageHeader title="Site reports" description="Usage across the whole organization." />
      <SiteOverview />
    </div>
  );
}
