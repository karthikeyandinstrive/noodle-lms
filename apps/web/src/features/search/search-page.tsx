"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { BookOpen, FileText, MessageSquare, MessagesSquare, Search, User } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ErrorAlert, PageHeader } from "@/components/common";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

type SearchType = "courses" | "activities" | "forum" | "users" | "messages";
type Hit = { id: string; title: string; snippet: string; link: string; context: string | null; kind: string | null };
type SearchResult = { query: string; groups: { type: SearchType; items: Hit[] }[] };

const TYPES: SearchType[] = ["courses", "activities", "forum", "users", "messages"];
const ICONS: Record<SearchType, React.ComponentType<{ className?: string }>> = {
  courses: BookOpen,
  activities: FileText,
  forum: MessagesSquare,
  users: User,
  messages: MessageSquare,
};

function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

/** Wraps occurrences of the query terms in <mark> (plain text in, React nodes out — no HTML injection). */
function Highlight({ text, query }: { text: string; query: string }) {
  const terms = query
    .toLowerCase()
    .replace(/["()]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && t !== "or" && !t.startsWith("-"));
  if (!terms.length || !text) return <>{text}</>;
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return (
    <>
      {text.split(re).map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded-sm bg-yellow-200/70 px-0.5 text-inherit dark:bg-yellow-500/30">
            {part}
          </mark>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}

export function SearchPage() {
  const t = useT();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [input, setInput] = useState(params.get("q") ?? "");
  const [types, setTypes] = useState<SearchType[]>(() => {
    const raw = params.get("types");
    const list = raw ? (raw.split(",").filter((x) => (TYPES as string[]).includes(x)) as SearchType[]) : [];
    return list.length ? list : TYPES;
  });
  // The highlighted result resets whenever new results arrive (tied to the data it was chosen for).
  const [activeState, setActiveState] = useState<{ data: unknown; index: number }>({ data: null, index: -1 });
  const inputRef = useRef<HTMLInputElement>(null);
  const q = useDebounced(input.trim());

  // Keep the URL shareable (?q=…&types=…) without adding history entries.
  useEffect(() => {
    const sp = new URLSearchParams();
    if (q) sp.set("q", q);
    if (types.length !== TYPES.length) sp.set("types", types.join(","));
    const qs = sp.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [q, types, pathname, router]);

  const search = useQuery({
    queryKey: ["search", q, types.join(",")],
    queryFn: ({ signal }) => api<SearchResult>("/search", { query: { q, types: types.join(",") }, signal }),
    enabled: q.length > 0 && types.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });

  const labels: Record<SearchType, string> = {
    courses: t("search.type.courses", "Courses"),
    activities: t("search.type.activities", "Activities"),
    forum: t("search.type.forum", "Forum posts"),
    users: t("search.type.users", "People"),
    messages: t("search.type.messages", "Messages"),
  };

  const groups = useMemo(() => (search.data?.groups ?? []).filter((g) => g.items.length > 0), [search.data]);
  const flat = useMemo(() => groups.flatMap((g) => g.items.map((item) => ({ type: g.type, item }))), [groups]);
  const active = activeState.data === search.data ? activeState.index : -1;
  const setActive = (next: number | ((cur: number) => number)) =>
    setActiveState({ data: search.data, index: typeof next === "function" ? next(active) : next });

  const optionId = (i: number) => `search-result-${i}`;
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!flat.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (a + 1) % flat.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a <= 0 ? flat.length - 1 : a - 1));
    } else if (e.key === "Enter" && active >= 0) {
      e.preventDefault();
      router.push(flat[active]!.item.link);
    } else if (e.key === "Escape") {
      setActive(-1);
    }
  };
  useEffect(() => {
    if (active >= 0) document.getElementById(optionId(active))?.scrollIntoView({ block: "nearest" });
  }, [active]);

  let index = -1;
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title={t("search.title", "Search")} description={t("search.description", "Find courses, activities, forum posts, people and your messages.")} />
      <div className="relative">
        <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={inputRef}
          type="search"
          autoFocus
          role="combobox"
          aria-expanded={flat.length > 0}
          aria-controls="search-results"
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? optionId(active) : undefined}
          aria-label={t("search.inputLabel", "Search")}
          placeholder={t("search.placeholder", "Search…")}
          className="h-10 pl-9 text-base"
          value={input}
          maxLength={200}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      <fieldset className="mt-3 flex flex-wrap gap-1.5">
        <legend className="sr-only">{t("search.filter", "Search in")}</legend>
        {TYPES.map((type) => {
          const on = types.includes(type);
          return (
            <button
              key={type}
              type="button"
              aria-pressed={on}
              onClick={() => setTypes((cur) => (on ? cur.filter((x) => x !== type) : TYPES.filter((x) => x === type || cur.includes(x))))}
              className={cn(
                "rounded-full border px-3 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
                on ? "border-primary bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-muted",
              )}
            >
              {labels[type]}
            </button>
          );
        })}
      </fieldset>

      <div className="mt-6" aria-busy={search.isFetching}>
        <p className="sr-only" role="status" aria-live="polite">
          {q && search.data ? t("search.resultCount", "{count} results", { count: flat.length }) : ""}
        </p>
        {!q ? (
          <p className="text-sm text-muted-foreground">{t("search.hint", "Type to search. Use ↑ ↓ to move through results and Enter to open one.")}</p>
        ) : search.isError ? (
          <ErrorAlert error={search.error} />
        ) : search.isPending ? (
          <p className="text-sm text-muted-foreground">{t("search.searching", "Searching…")}</p>
        ) : !flat.length ? (
          <p className="text-sm text-muted-foreground">{t("search.noResults", "No results for “{q}”.", { q })}</p>
        ) : (
          <div id="search-results" role="listbox" aria-label={t("search.results", "Search results")} className="space-y-6">
            {groups.map((g) => {
              const Icon = ICONS[g.type];
              return (
                <section key={g.type} role="group" aria-labelledby={`search-group-${g.type}`}>
                  <h2 id={`search-group-${g.type}`} className="mb-2 flex items-center gap-2 text-sm font-semibold text-muted-foreground">
                    <Icon className="size-4" aria-hidden /> {labels[g.type]}
                  </h2>
                  <ul className="divide-y rounded-xl border">
                    {g.items.map((item) => {
                      index++;
                      const i = index;
                      return (
                        <li key={`${g.type}-${item.id}`} id={optionId(i)} role="option" aria-selected={i === active}>
                          <Link
                            href={item.link}
                            onMouseEnter={() => setActive(i)}
                            className={cn("block px-4 py-3 outline-none hover:bg-muted/60", i === active && "bg-muted")}
                          >
                            <span className="flex items-baseline gap-2">
                              <span className="truncate font-medium">
                                <Highlight text={item.title} query={q} />
                              </span>
                              {item.kind && g.type === "activities" && <span className="shrink-0 text-xs text-muted-foreground">{item.kind}</span>}
                            </span>
                            {item.context && <span className="block truncate text-xs text-muted-foreground">{item.context}</span>}
                            {item.snippet && (
                              <span className="mt-1 line-clamp-2 block text-sm text-muted-foreground">
                                <Highlight text={item.snippet} query={q} />
                              </span>
                            )}
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
