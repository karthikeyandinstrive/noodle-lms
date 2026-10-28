"use client";

import { useQuery } from "@tanstack/react-query";
import { Award, Plus } from "lucide-react";
import Link from "next/link";
import { EmptyState, PageHeader, QueryState } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { CertificateTemplate } from "@/features/certificate/types";
import { api } from "@/lib/api";
import { useFormat, useT } from "@/lib/i18n";

export default function CertificateTemplatesPage() {
  const t = useT();
  const fmt = useFormat();
  const newButton = (
    <Link href="/admin/certificates/new" className={buttonVariants()}>
      <Plus aria-hidden /> {t("adminPage.certificates.new", "New template")}
    </Link>
  );
  const q = useQuery({ queryKey: ["certificates", "templates"], queryFn: () => api<CertificateTemplate[]>("/certificates/templates") });
  return (
    <div>
      <PageHeader
        title={t("nav.admin.certificates", "Certificate templates")}
        description={t("adminPage.certificates.description", "Design the PDF certificates issued by certificate activities.")}
        actions={newButton}
      />
      <QueryState query={q}>
        {q.data && !q.data.length && (
          <EmptyState
            title={t("adminPage.certificates.empty", "No templates yet")}
            description={t("adminPage.certificates.emptyHint", "Create a template, then add a Certificate activity to a course.")}
            action={newButton}
          />
        )}
        {q.data && q.data.length > 0 && (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {q.data.map((tpl) => (
              <li key={tpl.id}>
                <Link href={`/admin/certificates/${tpl.id}`} className="block rounded-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                  <Card className="h-full transition-colors hover:bg-muted/50">
                    <CardContent className="flex items-start gap-3">
                      <Award className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
                      <div className="min-w-0">
                        <p className="truncate font-medium">{tpl.name}</p>
                        <p className="text-sm text-muted-foreground">
                          {tpl.elements.length === 1
                            ? t("adminPage.certificates.elements.one", "{count} element", { count: tpl.elements.length })
                            : t("adminPage.certificates.elements.other", "{count} elements", { count: tpl.elements.length })}{" "}
                          · {t("adminPage.certificates.created", "created {date}", { date: fmt.date(tpl.createdAt, false) })}
                        </p>
                        <Badge variant="outline" className="mt-2 capitalize">
                          {tpl.orientation === "landscape"
                            ? t("adminPage.certificates.landscape", "Landscape")
                            : tpl.orientation === "portrait"
                              ? t("adminPage.certificates.portrait", "Portrait")
                              : tpl.orientation}
                        </Badge>
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </QueryState>
    </div>
  );
}
