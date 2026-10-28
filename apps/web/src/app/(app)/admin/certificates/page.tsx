"use client";

import { useQuery } from "@tanstack/react-query";
import { Award, Plus } from "lucide-react";
import Link from "next/link";
import { EmptyState, formatDate, PageHeader, QueryState } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { CertificateTemplate } from "@/features/certificate/types";
import { api } from "@/lib/api";

export default function CertificateTemplatesPage() {
  const q = useQuery({ queryKey: ["certificates", "templates"], queryFn: () => api<CertificateTemplate[]>("/certificates/templates") });
  return (
    <div>
      <PageHeader
        title="Certificate templates"
        description="Design the PDF certificates issued by certificate activities."
        actions={
          <Button render={<Link href="/admin/certificates/new" />}>
            <Plus /> New template
          </Button>
        }
      />
      <QueryState query={q}>
        {q.data && !q.data.length && (
          <EmptyState
            title="No templates yet"
            description="Create a template, then add a Certificate activity to a course."
            action={
              <Button render={<Link href="/admin/certificates/new" />}>
                <Plus /> New template
              </Button>
            }
          />
        )}
        {q.data && q.data.length > 0 && (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {q.data.map((t) => (
              <li key={t.id}>
                <Link href={`/admin/certificates/${t.id}`} className="block rounded-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                  <Card className="h-full transition-colors hover:bg-muted/50">
                    <CardContent className="flex items-start gap-3">
                      <Award className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
                      <div className="min-w-0">
                        <p className="truncate font-medium">{t.name}</p>
                        <p className="text-sm text-muted-foreground">
                          {t.elements.length} element{t.elements.length === 1 ? "" : "s"} · created {formatDate(t.createdAt, false)}
                        </p>
                        <Badge variant="outline" className="mt-2 capitalize">
                          {t.orientation}
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
