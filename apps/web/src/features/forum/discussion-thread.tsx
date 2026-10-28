"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { EyeOff, Lock, LockOpen, MessageSquareReply, Pencil, Pin, PinOff, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { HtmlContent, QueryState, formatDate, fullName } from "@/components/common";
import { activityKey } from "@/features/activities/use-activity";
import { api, errorMessage } from "@/lib/api";
import { forumKeys, useDiscussion, useForumInfo, type DiscussionDetail, type Post } from "./api";
import { htmlToText, textToHtml } from "./text";

type Node = Post & { children: Node[] };

function buildTree(posts: Post[]): Node[] {
  const byId = new Map<string, Node>(posts.map((p) => [p.id, { ...p, children: [] }]));
  const roots: Node[] = [];
  for (const p of posts) {
    const node = byId.get(p.id)!;
    const parent = p.parentId ? byId.get(p.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/** Threaded discussion with reply / edit / delete and moderator pin & lock. */
export function DiscussionThread({ activityId, discussionId, showTitle = true }: { activityId: string; discussionId: string; showTitle?: boolean }) {
  const query = useDiscussion(activityId, discussionId);
  const qc = useQueryClient();
  const d = query.data;
  const invalidate = async () => {
    await qc.invalidateQueries({ queryKey: forumKeys.all(activityId) });
  };

  const moderate = useMutation({
    mutationFn: (patch: { pinned?: boolean; locked?: boolean }) =>
      api(`/forums/${activityId}/discussions/${discussionId}`, { method: "PATCH", body: patch }),
    onSuccess: invalidate,
    onError: (e) => toast.error(errorMessage(e)),
  });

  const tree = useMemo(() => (d ? buildTree(d.posts) : []), [d]);
  const info = useForumInfo(activityId).data;

  return (
    <QueryState query={query}>
      {d && (
        <article className="space-y-4" aria-labelledby="discussion-title">
          <header className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              {showTitle && (
                <h2 id="discussion-title" className="text-xl font-semibold break-words">
                  {d.title}
                </h2>
              )}
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                {d.pinned && (
                  <Badge variant="secondary">
                    <Pin /> Pinned
                  </Badge>
                )}
                {d.locked && (
                  <Badge variant="outline">
                    <Lock /> Locked
                  </Badge>
                )}
                {d.groupName && <Badge variant="outline">{d.groupName}</Badge>}
                <span className="text-xs text-muted-foreground">
                  {d.replyCount} {d.replyCount === 1 ? "reply" : "replies"}
                </span>
              </div>
            </div>
            {info?.canModerate && (
              <div className="flex shrink-0 flex-wrap gap-2">
                <Button variant="outline" size="sm" disabled={moderate.isPending} onClick={() => moderate.mutate({ pinned: !d.pinned })}>
                  {d.pinned ? <PinOff /> : <Pin />} {d.pinned ? "Unpin" : "Pin"}
                </Button>
                <Button variant="outline" size="sm" disabled={moderate.isPending} onClick={() => moderate.mutate({ locked: !d.locked })}>
                  {d.locked ? <LockOpen /> : <Lock />} {d.locked ? "Unlock" : "Lock"}
                </Button>
              </div>
            )}
          </header>

          {d.repliesHidden && (
            <Alert>
              <EyeOff />
              <AlertDescription>This is a Q&amp;A forum: you&apos;ll see other people&apos;s replies after you post your own answer.</AlertDescription>
            </Alert>
          )}
          {d.locked && !info?.canModerate && <p className="text-sm text-muted-foreground">This discussion is locked; no new replies can be posted.</p>}

          <ol className="space-y-3">
            {tree.map((n) => (
              <PostItem key={n.id} node={n} depth={0} activityId={activityId} discussion={d} onChange={invalidate} />
            ))}
          </ol>
        </article>
      )}
    </QueryState>
  );
}

function PostItem({
  node,
  depth,
  activityId,
  discussion,
  onChange,
}: {
  node: Node;
  depth: number;
  activityId: string;
  discussion: DiscussionDetail;
  onChange: () => Promise<void>;
}) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<"view" | "reply" | "edit">("view");
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isRoot = node.parentId === null;

  const reply = useMutation({
    mutationFn: () => api<{ id: string }>(`/forums/${activityId}/discussions/${discussion.id}/posts`, { body: { parentId: node.id, message: textToHtml(text) } }),
    onSuccess: async () => {
      setMode("view");
      setText("");
      toast.success("Reply posted");
      await onChange();
      await qc.invalidateQueries({ queryKey: activityKey(activityId) });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const edit = useMutation({
    mutationFn: () =>
      api(`/forums/${activityId}/posts/${node.id}`, {
        method: "PATCH",
        body: { message: textToHtml(text), ...(isRoot && title.trim() ? { title: title.trim() } : {}) },
      }),
    onSuccess: async () => {
      setMode("view");
      toast.success("Post updated");
      await onChange();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const remove = useMutation({
    mutationFn: () => api(`/forums/${activityId}/posts/${node.id}`, { method: "DELETE" }),
    onSuccess: async () => {
      setConfirmDelete(false);
      toast.success("Post deleted");
      await onChange();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const canReply = discussion.canReply && !node.deleted;
  const indent = depth > 0 ? "border-l pl-3 sm:pl-5" : "";

  return (
    <li className={indent}>
      <div className={`rounded-xl border p-3 sm:p-4 ${isRoot ? "bg-card" : "bg-background"}`} id={`post-${node.id}`}>
        {node.deleted ? (
          <p className="text-sm text-muted-foreground italic">This post has been deleted.</p>
        ) : (
          <>
            <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
              <span className="font-medium">{fullName(node.author)}</span>
              <time className="text-xs text-muted-foreground" dateTime={node.createdAt}>
                {formatDate(node.createdAt)}
              </time>
              {node.updatedAt && <span className="text-xs text-muted-foreground">(edited)</span>}
            </div>
            {mode === "edit" ? (
              <form
                className="space-y-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (text.trim()) edit.mutate();
                }}
              >
                {isRoot && (
                  <div className="space-y-1">
                    <Label htmlFor={`title-${node.id}`}>Subject</Label>
                    <Input id={`title-${node.id}`} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={255} />
                  </div>
                )}
                <Label htmlFor={`edit-${node.id}`} className="sr-only">
                  Message
                </Label>
                <Textarea id={`edit-${node.id}`} rows={5} value={text} onChange={(e) => setText(e.target.value)} required />
                <div className="flex gap-2">
                  <Button type="submit" size="sm" disabled={edit.isPending || !text.trim()}>
                    {edit.isPending ? "Saving…" : "Save"}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setMode("view")}>
                    Cancel
                  </Button>
                </div>
              </form>
            ) : (
              <HtmlContent html={node.message} className="break-words" />
            )}
            {mode === "view" && (canReply || node.canEdit || node.canDelete) && (
              <div className="mt-3 flex flex-wrap gap-1">
                {canReply && (
                  <Button size="xs" variant="ghost" onClick={() => setMode("reply")}>
                    <MessageSquareReply /> Reply
                  </Button>
                )}
                {node.canEdit && (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      setText(htmlToText(node.message));
                      setTitle(discussion.title);
                      setMode("edit");
                    }}
                  >
                    <Pencil /> Edit
                  </Button>
                )}
                {node.canDelete && (
                  <Button size="xs" variant="ghost" className="text-destructive" onClick={() => setConfirmDelete(true)}>
                    <Trash2 /> Delete
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {mode === "reply" && (
        <form
          className="mt-2 space-y-2 border-l pl-3 sm:pl-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) reply.mutate();
          }}
        >
          <Label htmlFor={`reply-${node.id}`}>Reply to {fullName(node.author)}</Label>
          <Textarea id={`reply-${node.id}`} rows={4} value={text} onChange={(e) => setText(e.target.value)} autoFocus required />
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={reply.isPending || !text.trim()}>
              {reply.isPending ? "Posting…" : "Post reply"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setMode("view");
                setText("");
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}

      {node.children.length > 0 && (
        <ol className="mt-3 space-y-3">
          {node.children.map((c) => (
            // Indentation stops growing after a few levels so deep threads stay readable on phones.
            <PostItem key={c.id} node={c} depth={Math.min(depth + 1, 4)} activityId={activityId} discussion={discussion} onChange={onChange} />
          ))}
        </ol>
      )}

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this post?</AlertDialogTitle>
            <AlertDialogDescription>
              {isRoot ? "Deleting the first post removes the discussion once it has no other posts." : "The post will be removed from the discussion."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate()}>
              {remove.isPending ? "Deleting…" : "Delete"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}
