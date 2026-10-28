"use client";

import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { PageHeader } from "@/components/common";
import { TemplateEditor } from "@/features/certificate/template-editor";

export default function NewCertificateTemplatePage() {
  return (
    <div>
      <Link href="/admin/certificates" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ChevronLeft className="size-4" /> Certificate templates
      </Link>
      <PageHeader title="New certificate template" className="mt-2" />
      <TemplateEditor />
    </div>
  );
}
