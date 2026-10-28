"use client";

import { useQuery } from "@tanstack/react-query";
import { Plus, Search } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fullName } from "@/components/common";
import { api, type Paged } from "@/lib/api";
import { useDebounced } from "./shared";
import type { AdminUser } from "./types";

/**
 * Searches site users (needs user:view) and reports picks. `exclude` hides
 * users that are already members/enrolled.
 */
export function UserPicker({
  onPick,
  exclude = [],
  selected = [],
  multi = false,
  label = "Search users",
}: {
  onPick: (user: AdminUser) => void;
  exclude?: string[];
  selected?: string[];
  multi?: boolean;
  label?: string;
}) {
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim());
  const users = useQuery({
    queryKey: ["admin", "users", "picker", q],
    queryFn: () => api<Paged<AdminUser>>("/users", { query: { search: q, status: "active", pageSize: 10 } }),
    enabled: q.length >= 2,
  });
  const hidden = new Set(exclude);
  const items = users.data?.items.filter((u) => !hidden.has(u.id)) ?? [];
  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input className="pl-8" type="search" placeholder="Type at least 2 characters" aria-label={label} value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      {q.length >= 2 && (
        <ul className="max-h-56 divide-y overflow-auto rounded-md border" aria-live="polite">
          {users.isPending && <li className="p-2 text-sm text-muted-foreground">Searching…</li>}
          {users.isError && <li className="p-2 text-sm text-destructive">You can&apos;t search users here.</li>}
          {users.isSuccess && items.length === 0 && <li className="p-2 text-sm text-muted-foreground">No matching users.</li>}
          {items.map((u) => {
            const isSelected = selected.includes(u.id);
            return (
              <li key={u.id} className="flex items-center justify-between gap-2 p-2 text-sm">
                <div className="min-w-0">
                  <div className="truncate font-medium">{fullName(u)}</div>
                  <div className="truncate text-xs text-muted-foreground">{u.email}</div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant={isSelected ? "secondary" : "outline"}
                  aria-pressed={multi ? isSelected : undefined}
                  aria-label={`${isSelected ? "Selected" : "Add"} ${fullName(u)}`}
                  onClick={() => onPick(u)}
                >
                  {isSelected ? "Selected" : (
                    <>
                      <Plus /> Add
                    </>
                  )}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
