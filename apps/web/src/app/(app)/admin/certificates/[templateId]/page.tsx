"use client";

import { useQuery } from "@tanstack/react-query";
import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { PageHeader, QueryState } from "@/components/common";
import { TemplateEditor } from "@/features/certificate/template-editor";
import type { CertificateTemplate } from "@/features/certificate/types";
import { api } from "@/lib/api";

export default function EditCertificateTemplatePage() {
  const { templateId } = useParams<{ templateId: string }>();
  const q = useQuery({
    queryKey: ["certificates", "templates", templateId],
    queryFn: () => api<CertificateTemplate>(`/certificates/templates/${templateId}`),
  });
  return (
    <div>
      <Link href="/admin/certificates" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ChevronLeft className="size-4" /> Certificate templates
      </Link>
      <QueryState query={q}>
        {q.data && (
          <>
            <PageHeader title={q.data.name} description="Edit the layout of this certificate." className="mt-2" />
            <TemplateEditor key={q.data.id} template={q.data} />
          </>
        )}
      </QueryState>
    </div>
  );
}
