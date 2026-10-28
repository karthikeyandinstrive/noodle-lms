"use client";

import { useQuery } from "@tanstack/react-query";
import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { PageHeader, QueryState } from "@/components/common";
import { TemplateEditor } from "@/features/certificate/template-editor";
import type { CertificateTemplate } from "@/features/certificate/types";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";

export default function EditCertificateTemplatePage() {
  const { templateId } = useParams<{ templateId: string }>();
  const t = useT();
  const q = useQuery({
    queryKey: ["certificates", "templates", templateId],
    queryFn: () => api<CertificateTemplate>(`/certificates/templates/${templateId}`),
  });
  return (
    <div>
      <Link href="/admin/certificates" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ChevronLeft aria-hidden className="size-4" /> {t("nav.admin.certificates", "Certificate templates")}
      </Link>
      <QueryState query={q}>
        {q.data && (
          <>
            <PageHeader title={q.data.name} description={t("adminPage.certificates.editDescription", "Edit the layout of this certificate.")} className="mt-2" />
            <TemplateEditor key={q.data.id} template={q.data} />
          </>
        )}
      </QueryState>
    </div>
  );
}
