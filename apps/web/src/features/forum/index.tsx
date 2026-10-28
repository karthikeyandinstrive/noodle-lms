"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Bell, BellOff, ChevronLeft, ChevronRight, Lock, MessageSquare, MessagesSquare, Pin, Plus, Search } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { EmptyState, ErrorAlert, HtmlContent, QueryState, fullName } from "@/components/common";
import { RichTextEditor } from "@/components/rich-text-editor";
import { activityKey } from "@/features/activities/use-activity";
import { api, errorMessage } from "@/lib/api";
import { useFormat, useT } from "@/lib/i18n";
import type { ActivityTypeUI, ActivityViewProps, SettingsFieldsProps } from "../activities/types";
import { forumKeys, useDiscussions, useForumInfo, useForumSearch, type ForumInfo, type ForumType } from "./api";
import { DiscussionThread } from "./discussion-thread";

const TYPE_LABELS: Record<ForumType, { key: string; label: string }> = {
  general: { key: "forum.type.general", label: "Standard forum for general use" },
  news: { key: "forum.type.news", label: "Announcements (only teachers post)" },
  qanda: { key: "forum.type.qanda", label: "Q&A (students answer before seeing others)" },
  single: { key: "forum.type.single", label: "A single simple discussion" },
};

const selectClass = "h-8 w-full rounded-lg border bg-background px-2 text-sm";

function ForumView({ activity }: ActivityViewProps) {
  const info = useForumInfo(activity.id);
  return (
    <QueryState query={info}>
      {info.data && (
        <div className="space-y-6">
          <HtmlContent html={info.data.intro} />
          <ForumToolbar info={info.data} />
          {info.data.type === "single" && info.data.singleDiscussionId ? (
            <DiscussionThread activityId={activity.id} discussionId={info.data.singleDiscussionId} showTitle={false} />
          ) : (
            <DiscussionList info={info.data} />
          )}
        </div>
      )}
    </QueryState>
  );
}

function ForumToolbar({ info }: { info: ForumInfo }) {
  const qc = useQueryClient();
  const t = useT();
  const subscribe = useMutation({
    mutationFn: (subscribed: boolean) => api<{ subscribed: boolean }>(`/forums/${info.activityId}/subscription`, { method: "PUT", body: { subscribed } }),
    onSuccess: (r) => {
      qc.setQueryData<ForumInfo>(forumKeys.info(info.activityId), (old) => (old ? { ...old, subscribed: r.subscribed } : old));
      toast.success(r.subscribed ? t("forum.subscribed", "You'll be notified about new posts") : t("forum.unsubscribed", "Unsubscribed"));
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-2 text-sm">
        {info.subscriptionMode === "optional" && (
          <>
            <Switch
              id="forum-subscribe"
              checked={info.subscribed}
              disabled={subscribe.isPending}
              onCheckedChange={(v) => subscribe.mutate(v)}
            />
            <Label htmlFor="forum-subscribe" className="font-normal">
              {info.subscribed ? <Bell aria-hidden className="size-4" /> : <BellOff aria-hidden className="size-4" />} {t("forum.emailMe", "Email me about new posts")}
            </Label>
          </>
        )}
        {info.subscriptionMode === "forced" && (
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <Bell aria-hidden className="size-4" /> {t("forum.forcedSubscription", "Everyone is subscribed to this forum")}
          </span>
        )}
      </div>
      {info.canStartDiscussion && <NewDiscussionButton info={info} />}
    </div>
  );
}

function NewDiscussionButton({ info }: { info: ForumInfo }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [groupId, setGroupId] = useState<string>("");
  const [pinned, setPinned] = useState(false);
  const router = useRouter();
  const qc = useQueryClient();
  const mustPickGroup = info.groupMode !== "none" && !info.canModerate;
  const t = useT();

  const create = useMutation({
    mutationFn: () =>
      api<{ id: string }>(`/forums/${info.activityId}/discussions`, {
        body: {
          title: title.trim(),
          message,
          groupId: groupId || (mustPickGroup ? info.groups[0]?.id : null) || null,
          ...(info.canModerate ? { pinned } : {}),
        },
      }),
    onSuccess: async ({ id }) => {
      setOpen(false);
      setTitle("");
      setMessage("");
      toast.success(info.type === "news" ? t("forum.announcementPosted", "Announcement posted") : t("forum.discussionStarted", "Discussion started"));
      await qc.invalidateQueries({ queryKey: forumKeys.all(info.activityId) });
      await qc.invalidateQueries({ queryKey: activityKey(info.activityId) });
      router.push(`/activities/${info.activityId}/forum/${id}`);
    },
  });

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus aria-hidden /> {info.type === "news" ? t("forum.newAnnouncement", "New announcement") : t("forum.newDiscussion", "New discussion")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <DialogHeader>
              <DialogTitle>{info.type === "news" ? t("forum.newAnnouncement", "New announcement") : t("forum.startDiscussion", "Start a discussion")}</DialogTitle>
              <DialogDescription>
                {info.type === "news"
                  ? t("forum.newsNotice", "All course participants will be notified.")
                  : t("forum.subscribersNotice", "Subscribers will be notified of your post.")}
              </DialogDescription>
            </DialogHeader>
            {create.isError && <ErrorAlert error={create.error} />}
            <div className="space-y-1.5">
              <Label htmlFor="d-title">{t("forum.subject", "Subject")}</Label>
              <Input id="d-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={255} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="d-message">{t("forum.message", "Message")}</Label>
              <RichTextEditor id="d-message" value={message} onChange={setMessage} minHeight={160} />
            </div>
            {info.groupMode !== "none" && info.groups.length > 0 && (
              <div className="space-y-1.5">
                <Label htmlFor="d-group">{t("forum.group", "Group")}</Label>
                <select id="d-group" className={selectClass} value={groupId} onChange={(e) => setGroupId(e.target.value)}>
                  {!mustPickGroup && <option value="">{t("forum.allParticipants", "All participants")}</option>}
                  {info.groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {info.canModerate && (
              <div className="flex items-center gap-2">
                <Switch id="d-pinned" checked={pinned} onCheckedChange={setPinned} />
                <Label htmlFor="d-pinned" className="font-normal">
                  {t("forum.pinToTop", "Pin to the top")}
                </Label>
              </div>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                {t("common.cancel", "Cancel")}
              </Button>
              <Button type="submit" disabled={create.isPending || !title.trim() || !hasText(message)}>
                {create.isPending ? t("forum.posting", "Posting…") : t("forum.post", "Post")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** True when an editor's HTML has visible text (the editor yields "" when empty). */
function hasText(html: string) {
  return html.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim().length > 0;
}

function useDebounced(value: string, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setV(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return v;
}

function DiscussionList({ info }: { info: ForumInfo }) {
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState("");
  const q = useDebounced(searchInput.trim());
  const searching = q.length >= 2;
  const list = useDiscussions(info.activityId, page);
  const [searchPage, setSearchPage] = useState(1);
  const search = useForumSearch(info.activityId, q, searchPage);
  const t = useT();
  const fmt = useFormat();

  return (
    <section className="space-y-3" aria-label={t("forum.discussions", "Discussions")}>
      <div className="relative">
        <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          aria-label={t("forum.searchLabel", "Search this forum")}
          placeholder={t("forum.searchPlaceholder", "Search this forum…")}
          className="pl-8"
          value={searchInput}
          onChange={(e) => {
            setSearchInput(e.target.value);
            setSearchPage(1);
          }}
        />
      </div>

      {searching ? (
        <QueryState query={search}>
          {search.data &&
            (search.data.items.length === 0 ? (
              <div role="status">
                <EmptyState title={t("forum.noMatches", "No matching posts")} description={t("forum.nothingFound", "Nothing found for “{query}”.", { query: q })} />
              </div>
            ) : (
              <>
                <p className="text-sm text-muted-foreground" role="status">
                  {search.data.total === 1
                    ? t("forum.results.one", "{count} result", { count: search.data.total })
                    : t("forum.results.other", "{count} results", { count: search.data.total })}
                </p>
                <ul className="divide-y rounded-xl border">
                  {search.data.items.map((h) => (
                    <li key={h.postId}>
                      <Link href={`/activities/${info.activityId}/forum/${h.discussionId}#post-${h.postId}`} className="block p-3 hover:bg-muted/50 sm:p-4">
                        <p className="font-medium break-words">{h.discussionTitle}</p>
                        <p className="mt-1 line-clamp-2 text-sm break-words text-muted-foreground">{h.excerpt}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {fullName(h.author)} · {fmt.date(h.createdAt)}
                        </p>
                      </Link>
                    </li>
                  ))}
                </ul>
                <Pager page={searchPage} pageSize={search.data.pageSize} total={search.data.total} onPage={setSearchPage} />
              </>
            ))}
        </QueryState>
      ) : (
        <QueryState query={list}>
          {list.data &&
            (list.data.items.length === 0 ? (
              <EmptyState
                title={info.type === "news" ? t("forum.noAnnouncements", "No announcements yet") : t("forum.noDiscussions", "No discussions yet")}
                description={info.canStartDiscussion ? t("forum.startFirst", "Start the first one.") : undefined}
              />
            ) : (
              <>
                <ul className="divide-y rounded-xl border">
                  {list.data.items.map((d) => (
                    <li key={d.id}>
                      <Link href={`/activities/${info.activityId}/forum/${d.id}`} className="flex flex-col gap-1 p-3 hover:bg-muted/50 sm:flex-row sm:items-center sm:justify-between sm:p-4">
                        <div className="min-w-0">
                          <p className="flex flex-wrap items-center gap-1.5 font-medium">
                            {d.pinned && (
                              <>
                                <Pin className="size-3.5 text-primary" aria-hidden />
                                <span className="sr-only">{t("forum.pinned", "Pinned")}</span>
                              </>
                            )}
                            {d.locked && (
                              <>
                                <Lock className="size-3.5 text-muted-foreground" aria-hidden />
                                <span className="sr-only">{t("forum.locked", "Locked")}</span>
                              </>
                            )}
                            <span className="break-words">{d.title}</span>
                            {d.groupName && <Badge variant="outline">{d.groupName}</Badge>}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {t("forum.startedBy", "Started by {name}", { name: fullName(d.author) })} · {fmt.date(d.createdAt, false)}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <MessageSquare className="size-3.5" aria-hidden /> {d.replyCount}
                            <span className="sr-only">{d.replyCount === 1 ? t("forum.replyWord.one", "reply") : t("forum.replyWord.other", "replies")}</span>
                          </span>
                          <span>{t("forum.lastPost", "Last post {date}", { date: fmt.date(d.lastPostAt) })}</span>
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
                <Pager page={page} pageSize={list.data.pageSize} total={list.data.total} onPage={setPage} />
              </>
            ))}
        </QueryState>
      )}
    </section>
  );
}

function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const t = useT();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <nav className="flex items-center justify-between gap-2" aria-label={t("forum.pagination", "Pagination")}>
      <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        <ChevronLeft aria-hidden /> {t("common.previous", "Previous")}
      </Button>
      <span className="text-sm text-muted-foreground">
        {t("forum.pageOf", "Page {page} of {pages}", { page, pages })}
      </span>
      <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        {t("common.next", "Next")} <ChevronRight aria-hidden />
      </Button>
    </nav>
  );
}

function ForumSettings({ value, onChange, mode }: SettingsFieldsProps) {
  const set = (k: string, v: unknown) => onChange({ ...value, [k]: v });
  const type = (value.type as ForumType) ?? "general";
  const t = useT();
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="forum-type">{t("forum.forumType", "Forum type")}</Label>
        <select
          id="forum-type"
          className={selectClass}
          value={type}
          onChange={(e) => set("type", e.target.value)}
          // Converting to/from a single discussion is not supported after creation.
          disabled={mode === "edit" && type === "single"}
        >
          {(Object.keys(TYPE_LABELS) as ForumType[])
            .filter((ft) => mode === "create" || type === "single" || ft !== "single")
            .map((ft) => (
              <option key={ft} value={ft}>
                {t(TYPE_LABELS[ft].key, TYPE_LABELS[ft].label)}
              </option>
            ))}
        </select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="forum-intro">{type === "single" ? t("forum.discussionPrompt", "Discussion prompt") : t("forum.introduction", "Introduction")}</Label>
        <RichTextEditor id="forum-intro" minHeight={100} value={(value.intro as string | null) ?? ""} onChange={(html) => set("intro", html || null)} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="forum-sub">{t("forum.subscription", "Subscription")}</Label>
          <select id="forum-sub" className={selectClass} value={(value.subscriptionMode as string) ?? "optional"} onChange={(e) => set("subscriptionMode", e.target.value)}>
            <option value="optional">{t("forum.subscription.optional", "Optional (people choose)")}</option>
            <option value="forced">{t("forum.subscription.forced", "Forced (everyone subscribed)")}</option>
            <option value="disabled">{t("forum.subscription.disabled", "Disabled")}</option>
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="forum-posts">{t("forum.completionPosts", "Posts required for completion")}</Label>
          <Input
            id="forum-posts"
            type="number"
            min={1}
            max={100}
            aria-describedby="forum-posts-hint"
            value={String(value.completionPosts ?? 1)}
            onChange={(e) => set("completionPosts", Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
          />
          <p id="forum-posts-hint" className="text-xs text-muted-foreground">
            {t("forum.completionPostsHint", "Used when completion is set to “Submitted / participated”.")}
          </p>
        </div>
      </div>
    </div>
  );
}

export const forumActivity: ActivityTypeUI = {
  type: "forum",
  label: "Forum",
  description: "Discussion threads",
  icon: MessagesSquare,
  defaults: { type: "general", intro: null, subscriptionMode: "optional", completionPosts: 1 },
  defaultCompletion: "submit",
  View: ForumView,
  SettingsFields: ForumSettings,
};
