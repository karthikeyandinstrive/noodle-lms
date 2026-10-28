"use client";

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, BellOff, MoreHorizontal, Pencil, Send, Trash2, Users } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { EmptyState, ErrorAlert, HtmlContent } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { api, errorMessage, type Paged } from "@/lib/api";
import { useFormat, useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { NewMessageDialog } from "./new-message-dialog";
import { conversationTitle, initials, messagingKeys, type Conversation, type Message } from "./types";

const LIST_POLL_MS = 30_000;
const THREAD_POLL_MS = 10_000;
const PAGE_SIZE = 30;
const MAX_LENGTH = 10_000;

/** Two-pane messaging (single pane on small screens). The open conversation lives in `?c=`. */
export function MessagesPage() {
  const t = useT();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const selectedId = params.get("c");

  const conversations = useQuery({
    queryKey: messagingKeys.conversations,
    queryFn: () => api<Conversation[]>("/messages/conversations"),
    refetchInterval: LIST_POLL_MS,
  });

  const select = (id: string | null) => router.replace(id ? `${pathname}?c=${id}` : pathname, { scroll: false });
  const selected = conversations.data?.find((c) => c.id === selectedId) ?? null;

  return (
    <div className="flex h-[calc(100dvh-8rem)] min-h-[28rem] overflow-hidden rounded-xl border bg-background">
      <section
        aria-label={t("messages.conversations", "Conversations")}
        className={cn("flex w-full flex-col border-r md:w-80 md:shrink-0", selectedId && "hidden md:flex")}
      >
        <div className="flex items-center justify-between gap-2 border-b p-3">
          <h1 className="text-lg font-semibold">{t("nav.messages", "Messages")}</h1>
          <NewMessageDialog onStarted={select} />
        </div>
        <ConversationList query={conversations} selectedId={selectedId} onSelect={select} />
      </section>
      <section aria-label={t("messages.thread", "Conversation")} className={cn("min-w-0 flex-1 flex-col", selectedId ? "flex" : "hidden md:flex")}>
        {selectedId ? (
          selected ? (
            <Thread key={selected.id} conversation={selected} onBack={() => select(null)} />
          ) : conversations.isPending ? (
            <div className="p-4">
              <Skeleton className="h-8 w-1/2" />
            </div>
          ) : (
            <div className="p-4">
              <Button variant="ghost" size="sm" onClick={() => select(null)}>
                <ArrowLeft aria-hidden /> {t("messages.back", "Back")}
              </Button>
              <EmptyState title={t("messages.notFound", "Conversation not found")} />
            </div>
          )
        ) : (
          <div className="m-auto p-6 text-center text-sm text-muted-foreground">{t("messages.pick", "Select a conversation or start a new one.")}</div>
        )}
      </section>
    </div>
  );
}

function ConversationList({
  query,
  selectedId,
  onSelect,
}: {
  query: { data?: Conversation[]; isPending: boolean; isError: boolean; error: unknown };
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const t = useT();
  const fmt = useFormat();
  if (query.isPending)
    return (
      <div className="space-y-2 p-3" aria-busy="true">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </div>
    );
  if (query.isError)
    return (
      <div className="p-3">
        <ErrorAlert error={query.error} />
      </div>
    );
  if (!query.data?.length)
    return <p className="p-4 text-sm text-muted-foreground">{t("messages.none", "No conversations yet.")}</p>;
  return (
    <ul className="flex-1 overflow-y-auto">
      {query.data.map((c) => {
        const title = conversationTitle(c, t("messages.unknown", "Conversation"));
        const active = c.id === selectedId;
        return (
          <li key={c.id}>
            <button
              type="button"
              onClick={() => onSelect(c.id)}
              aria-current={active ? "true" : undefined}
              className={cn(
                "flex w-full items-start gap-3 border-b px-3 py-2.5 text-left outline-none hover:bg-muted/60 focus-visible:bg-muted",
                active && "bg-muted",
              )}
            >
              <span aria-hidden className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">
                {c.type === "direct" ? initials(title) : <Users className="size-4" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className={cn("truncate text-sm", c.unread ? "font-semibold" : "font-medium")}>{title}</span>
                  {c.muted && <BellOff aria-label={t("messages.muted", "Muted")} className="size-3.5 shrink-0 text-muted-foreground" />}
                  {c.lastMessage && <span className="ml-auto shrink-0 text-xs text-muted-foreground">{fmt.date(c.lastMessage.createdAt)}</span>}
                </span>
                <span className="flex items-center gap-2">
                  <span className="truncate text-xs text-muted-foreground">
                    {c.lastMessage ? (c.lastMessage.deleted ? t("messages.deletedMessage", "Message deleted") : c.lastMessage.preview) : t("messages.noMessages", "No messages yet")}
                  </span>
                  {c.unread > 0 && (
                    <Badge className="ml-auto shrink-0" aria-label={t("messages.unreadCount", "{count} unread", { count: c.unread })}>
                      {c.unread > 99 ? "99+" : c.unread}
                    </Badge>
                  )}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function Thread({ conversation, onBack }: { conversation: Conversation; onBack: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const title = conversationTitle(conversation, t("messages.unknown", "Conversation"));
  const bottomRef = useRef<HTMLDivElement>(null);

  const thread = useInfiniteQuery({
    queryKey: messagingKeys.thread(conversation.id),
    queryFn: ({ pageParam }) =>
      api<Paged<Message>>(`/messages/conversations/${conversation.id}/messages`, { query: { page: pageParam, pageSize: PAGE_SIZE } }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page * last.pageSize < last.total ? last.page + 1 : undefined),
    refetchInterval: THREAD_POLL_MS,
  });

  // Oldest first for display; pages are newest-first from the API.
  const items = useMemo(() => {
    const seen = new Set<string>();
    const all: Message[] = [];
    for (const p of thread.data?.pages ?? []) {
      for (const m of p.items) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        all.push(m);
      }
    }
    return all.reverse();
  }, [thread.data]);
  const newestId = items.at(-1)?.id;

  const refreshList = () => {
    qc.invalidateQueries({ queryKey: messagingKeys.conversations });
    qc.invalidateQueries({ queryKey: messagingKeys.unread });
  };

  // Mark as read when the conversation opens and whenever a new message shows up.
  const markRead = useMutation({
    mutationFn: () => api(`/messages/conversations/${conversation.id}/read`, { body: {} }),
    onSuccess: () => {
      refreshList();
      qc.invalidateQueries({ queryKey: ["notifications"] });
    },
  });
  const markReadNow = markRead.mutate; // stable across renders
  useEffect(() => {
    if (newestId) markReadNow();
  }, [newestId, markReadNow]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [newestId]);

  const action = useMutation({
    mutationFn: (a: "mute" | "unmute" | "block" | "unblock" | "leave") => {
      if (a === "mute" || a === "unmute") return api(`/messages/conversations/${conversation.id}/mute`, { method: "PUT", body: { muted: a === "mute" } });
      if (a === "block") return api("/messages/blocks", { body: { userId: conversation.otherUser!.id } });
      if (a === "unblock") return api(`/messages/blocks/${conversation.otherUser!.id}`, { method: "DELETE" });
      return api(`/messages/conversations/${conversation.id}/members/me`, { method: "DELETE" });
    },
    onSuccess: (_r, a) => {
      refreshList();
      if (a === "leave") onBack();
      toast.success(
        {
          mute: t("messages.mutedToast", "Conversation muted"),
          unmute: t("messages.unmutedToast", "Conversation unmuted"),
          block: t("messages.blockedToast", "User blocked"),
          unblock: t("messages.unblockedToast", "User unblocked"),
          leave: t("messages.leftToast", "You left the group"),
        }[a],
      );
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const memberNames = conversation.type !== "direct" ? conversation.members.map((m) => m.firstName).join(", ") : null;

  return (
    <>
      <header className="flex items-center gap-2 border-b p-3">
        <Button variant="ghost" size="icon-sm" className="md:hidden" aria-label={t("messages.back", "Back")} onClick={onBack}>
          <ArrowLeft />
        </Button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-semibold">{title}</h2>
          {memberNames && <p className="truncate text-xs text-muted-foreground">{memberNames}</p>}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t("messages.actions", "Conversation actions")} />}>
            <MoreHorizontal aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => action.mutate(conversation.muted ? "unmute" : "mute")}>
              {conversation.muted ? t("messages.unmute", "Unmute notifications") : t("messages.mute", "Mute notifications")}
            </DropdownMenuItem>
            {conversation.type === "direct" && conversation.otherUser && (
              <>
                <DropdownMenuSeparator />
                {conversation.blocked ? (
                  <DropdownMenuItem onClick={() => action.mutate("unblock")}>{t("messages.unblock", "Unblock")}</DropdownMenuItem>
                ) : (
                  <DropdownMenuItem variant="destructive" onClick={() => action.mutate("block")}>
                    {t("messages.block", "Block")}
                  </DropdownMenuItem>
                )}
              </>
            )}
            {conversation.type === "group" && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={() => action.mutate("leave")}>
                  {t("messages.leave", "Leave group")}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <div className="flex-1 overflow-y-auto p-3" aria-live="polite" aria-relevant="additions">
        {thread.isPending ? (
          <div className="space-y-3">
            <Skeleton className="h-10 w-2/3" />
            <Skeleton className="ml-auto h-10 w-1/2" />
          </div>
        ) : thread.isError ? (
          <ErrorAlert error={thread.error} />
        ) : (
          <>
            {thread.hasNextPage && (
              <div className="mb-3 text-center">
                <Button variant="outline" size="sm" disabled={thread.isFetchingNextPage} onClick={() => thread.fetchNextPage()}>
                  {t("messages.older", "Load older messages")}
                </Button>
              </div>
            )}
            {!items.length && <p className="py-8 text-center text-sm text-muted-foreground">{t("messages.say", "No messages yet. Say hello!")}</p>}
            <ol className="space-y-2">
              {items.map((m) => (
                <MessageBubble key={m.id} message={m} showAuthor={conversation.type !== "direct"} conversationId={conversation.id} />
              ))}
            </ol>
            <div ref={bottomRef} />
          </>
        )}
      </div>

      {conversation.canPost ? (
        <Composer conversationId={conversation.id} onSent={refreshList} />
      ) : (
        <p className="border-t p-3 text-sm text-muted-foreground">
          {conversation.blocked
            ? t("messages.youBlocked", "You blocked this person. Unblock them to send messages.")
            : t("messages.cannotPost", "You can't send messages in this conversation.")}
        </p>
      )}
    </>
  );
}

function MessageBubble({ message: m, showAuthor, conversationId }: { message: Message; showAuthor: boolean; conversationId: string }) {
  const t = useT();
  const fmt = useFormat();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const invalidate = () => qc.invalidateQueries({ queryKey: messagingKeys.thread(conversationId) });

  const save = useMutation({
    mutationFn: () => api(`/messages/${m.id}`, { method: "PATCH", body: { body: draft } }),
    onSuccess: () => {
      setEditing(false);
      invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: () => api(`/messages/${m.id}`, { method: "DELETE" }),
    onSuccess: () => {
      invalidate();
      qc.invalidateQueries({ queryKey: messagingKeys.conversations });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <li className={cn("flex", m.mine ? "justify-end" : "justify-start")}>
      <div className={cn("group max-w-[85%] rounded-2xl px-3 py-2 text-sm sm:max-w-[70%]", m.mine ? "bg-primary text-primary-foreground" : "bg-muted")}>
        {showAuthor && !m.mine && (
          <p className="mb-0.5 text-xs font-medium opacity-80">
            {m.user.firstName} {m.user.lastName}
          </p>
        )}
        {m.deleted ? (
          <p className="italic opacity-70">{t("messages.deletedMessage", "Message deleted")}</p>
        ) : editing ? (
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (draft.trim()) save.mutate();
            }}
          >
            <Textarea
              aria-label={t("messages.editLabel", "Edit message")}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              maxLength={MAX_LENGTH}
              className="bg-background text-foreground"
              rows={3}
            />
            <div className="flex justify-end gap-2">
              <Button type="button" size="xs" variant="secondary" onClick={() => setEditing(false)}>
                {t("common.cancel", "Cancel")}
              </Button>
              <Button type="submit" size="xs" variant="secondary" disabled={save.isPending}>
                {t("common.save", "Save")}
              </Button>
            </div>
          </form>
        ) : (
          <HtmlContent html={m.body} className={cn("break-words whitespace-pre-wrap", m.mine && "text-primary-foreground [&_a]:text-primary-foreground")} />
        )}
        <p className="mt-1 flex items-center justify-end gap-1 text-[11px] opacity-70">
          {m.edited && <span>{t("messages.edited", "edited")} ·</span>}
          <time dateTime={m.createdAt}>{fmt.date(m.createdAt)}</time>
          {m.canEdit && !editing && (
            <>
              <button
                type="button"
                className="ml-1 rounded p-0.5 outline-none hover:bg-black/10 focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={t("messages.edit", "Edit message")}
                onClick={() => {
                  setDraft(htmlToText(m.body));
                  setEditing(true);
                }}
              >
                <Pencil className="size-3" aria-hidden />
              </button>
              <button
                type="button"
                className="rounded p-0.5 outline-none hover:bg-black/10 focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={t("messages.delete", "Delete message")}
                onClick={() => {
                  if (window.confirm(t("messages.confirmDelete", "Delete this message?"))) remove.mutate();
                }}
              >
                <Trash2 className="size-3" aria-hidden />
              </button>
            </>
          )}
        </p>
      </div>
    </li>
  );
}

/** Messages are written as plain text; the server stores them sanitized (entities escaped). */
function htmlToText(html: string) {
  if (typeof document === "undefined") return html;
  const el = document.createElement("textarea");
  el.innerHTML = html.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, "");
  return el.value;
}

function Composer({ conversationId, onSent }: { conversationId: string; onSent: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [body, setBody] = useState("");
  const send = useMutation({
    mutationFn: (text: string) => api<Message>(`/messages/conversations/${conversationId}/messages`, { body: { body: text } }),
    onSuccess: () => {
      setBody("");
      qc.invalidateQueries({ queryKey: messagingKeys.thread(conversationId) });
      onSent();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const submit = () => {
    const text = body.trim();
    if (text && !send.isPending) send.mutate(text);
  };
  return (
    <form
      className="flex items-end gap-2 border-t p-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Textarea
        aria-label={t("messages.compose", "Write a message")}
        placeholder={t("messages.composePlaceholder", "Write a message… (Enter to send, Shift+Enter for a new line)")}
        value={body}
        rows={2}
        maxLength={MAX_LENGTH}
        className="max-h-40 min-h-10 flex-1 resize-none"
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <Button type="submit" size="icon" aria-label={t("messages.send", "Send")} disabled={!body.trim() || send.isPending}>
        <Send />
      </Button>
    </form>
  );
}
