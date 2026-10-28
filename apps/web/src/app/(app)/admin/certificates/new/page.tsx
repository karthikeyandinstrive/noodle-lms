"use client";

import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { PageHeader } from "@/components/common";
import { TemplateEditor } from "@/features/certificate/template-editor";
import { useT } from "@/lib/i18n";

export default function NewCertificateTemplatePage() {
  const t = useT();
  return (
    <div>
      <Link href="/admin/certificates" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ChevronLeft aria-hidden className="size-4" /> {t("nav.admin.certificates", "Certificate templates")}
      </Link>
      <PageHeader title={t("adminPage.certificates.newTitle", "New certificate template")} className="mt-2" />
      <TemplateEditor />
    </div>
  );
}
