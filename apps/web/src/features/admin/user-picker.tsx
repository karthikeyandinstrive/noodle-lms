"use client";

import { useQuery } from "@tanstack/react-query";
import { Plus, Search } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fullName } from "@/components/common";
import { api, type Paged } from "@/lib/api";
import { useT } from "@/lib/i18n";
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
  label,
}: {
  onPick: (user: AdminUser) => void;
  exclude?: string[];
  selected?: string[];
  multi?: boolean;
  label?: string;
}) {
  const t = useT();
  const id = useId();
  const listId = `${id}-results`;
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim());
  const users = useQuery({
    queryKey: ["admin", "users", "picker", q],
    queryFn: () => api<Paged<AdminUser>>("/users", { query: { search: q, status: "active", pageSize: 10 } }),
    enabled: q.length >= 2,
  });
  const hidden = new Set(exclude);
  const items = users.data?.items.filter((u) => !hidden.has(u.id)) ?? [];
  const searchLabel = label ?? t("admin.shared.searchUsers", "Search users");
  const status = q.length < 2
    ? ""
    : users.isPending
      ? t("admin.picker.searching", "Searching…")
      : users.isError
        ? t("admin.picker.cantSearch", "You can't search users here.")
        : items.length === 0
          ? t("admin.picker.noMatches", "No matching users.")
          : items.length === 1
            ? t("admin.picker.results.one", "1 user found")
            : t("admin.picker.results.other", "{count} users found", { count: items.length });
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="sr-only">
        {searchLabel}
      </label>
      <div className="relative">
        <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          id={id}
          className="pl-8"
          type="search"
          autoComplete="off"
          placeholder={t("admin.picker.placeholder", "Type at least 2 characters")}
          aria-controls={q.length >= 2 ? listId : undefined}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <p role="status" aria-live="polite" className="sr-only">
        {status}
      </p>
      {q.length >= 2 && (
        <ul id={listId} aria-label={searchLabel} className="max-h-56 divide-y overflow-auto rounded-md border">
          {users.isPending && <li className="p-2 text-sm text-muted-foreground">{t("admin.picker.searching", "Searching…")}</li>}
          {users.isError && <li className="p-2 text-sm text-destructive">{t("admin.picker.cantSearch", "You can't search users here.")}</li>}
          {users.isSuccess && items.length === 0 && <li className="p-2 text-sm text-muted-foreground">{t("admin.picker.noMatches", "No matching users.")}</li>}
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
                  aria-label={isSelected ? t("admin.picker.selectedName", "Selected {name}", { name: fullName(u) }) : t("admin.picker.addName", "Add {name}", { name: fullName(u) })}
                  onClick={() => onPick(u)}
                >
                  {isSelected ? t("admin.picker.selected", "Selected") : (
                    <>
                      <Plus aria-hidden /> {t("common.add", "Add")}
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
