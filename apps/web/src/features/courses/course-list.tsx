"use client";

import { useQuery } from "@tanstack/react-query";
import { BookOpen, Search } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { EmptyState, QueryState } from "@/components/common";
import { api, fileUrl, type Paged } from "@/lib/api";
import type { Course } from "@/lib/types";

export function formatPrice(cents: number | null, currency: string | null) {
  if (!cents) return null;
  return new Intl.NumberFormat(undefined, { style: "currency", currency: currency ?? "USD" }).format(cents / 100);
}

export function CourseCard({ course }: { course: Course }) {
  const price = formatPrice(course.priceCents, course.currency);
  return (
    <Link href={`/courses/${course.id}`} className="group">
      <Card className="h-full overflow-hidden pt-0 transition-shadow group-hover:shadow-md">
        <div className="flex aspect-[16/7] items-center justify-center bg-gradient-to-br from-primary/15 to-primary/5">
          {course.imageFileId ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={fileUrl(course.imageFileId, true)} alt="" className="h-full w-full object-cover" />
          ) : (
            <BookOpen className="size-10 text-primary/50" />
          )}
        </div>
        <CardHeader>
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="secondary">{course.shortname}</Badge>
            {!course.visible && <Badge variant="outline">Hidden</Badge>}
            {course.enrolled && <Badge>Enrolled</Badge>}
            {price && !course.enrolled && <Badge variant="outline">{price}</Badge>}
          </div>
          <CardTitle className="line-clamp-2 text-base">{course.fullname}</CardTitle>
        </CardHeader>
        {course.summary && (
          <CardContent>
            <p className="line-clamp-2 text-sm text-muted-foreground">{course.summary.replace(/<[^>]+>/g, " ")}</p>
          </CardContent>
        )}
      </Card>
    </Link>
  );
}

export function CourseList({ mine }: { mine: boolean }) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: ["courses", { mine, search, page }],
    queryFn: () => api<Paged<Course>>("/courses", { query: { mine: mine || undefined, search, page, pageSize: 12 } }),
  });
  const pages = query.data ? Math.max(1, Math.ceil(query.data.total / query.data.pageSize)) : 1;

  return (
    <div className="space-y-4">
      <div className="relative max-w-sm">
        <Search className="absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
        <Input
          className="pl-8"
          placeholder="Search courses"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          aria-label="Search courses"
        />
      </div>
      <QueryState query={query}>
        {query.data?.items.length ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {query.data.items.map((c) => (
                <CourseCard key={c.id} course={c} />
              ))}
            </div>
            {pages > 1 && (
              <div className="flex items-center justify-center gap-2">
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                  Previous
                </Button>
                <span className="text-sm text-muted-foreground">
                  Page {page} of {pages}
                </span>
                <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>
                  Next
                </Button>
              </div>
            )}
          </>
        ) : (
          <EmptyState
            title={mine ? "You're not enrolled in any courses yet" : "No courses found"}
            action={mine ? <Button render={<Link href="/catalog" />}>Browse the catalog</Button> : undefined}
          />
        )}
      </QueryState>
    </div>
  );
}
