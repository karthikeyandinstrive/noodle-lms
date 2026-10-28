"use client";

import { PageHeader } from "@/components/common";
import { BadgeManager } from "@/features/badges/badge-manager";
import { useSession } from "@/lib/session";

export default function SiteBadgesPage() {
  const session = useSession();
  return (
    <div>
      <PageHeader title="Site badges" description="Badges that can be earned across the whole organization." />
      <BadgeManager courseId={null} canAward={session.can("badge:award") || session.can("badge:manage")} />
    </div>
  );
}
