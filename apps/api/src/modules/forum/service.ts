import { and, eq, inArray, isNull } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { forumDiscussions, forumPosts, forumSubscriptions, forums, groupMembers, type DB } from "@lms/db";
import { z } from "zod";
import { registerActivityType, type ActivityRow } from "../../core/activity-types";
import { requireUser } from "../../core/auth";
import { badRequest, forbidden, must, notFound } from "../../core/errors";
import { notify } from "../../core/notify";
import { hasCapability } from "../../core/rbac";
import { cleanHtml } from "../../core/sanitize";
import { loadActivity } from "../activities/service";
import { activeParticipantIds, htmlExcerpt, staffIds, userGroupIds } from "./people";

export type ForumRow = typeof forums.$inferSelect;
export type DiscussionRow = typeof forumDiscussions.$inferSelect;
export type PostRow = typeof forumPosts.$inferSelect;
export type GroupMode = "none" | "separate" | "visible";

/** Own posts can be edited for this long; moderators can edit any time. */
export const EDIT_WINDOW_MS = 30 * 60 * 1000;

export const forumSettings = z.object({
  type: z.enum(["general", "news", "qanda", "single"]).default("general"),
  intro: z.string().max(50_000).nullable().optional(),
  subscriptionMode: z.enum(["optional", "forced", "disabled"]).default("optional"),
  /** Posts a learner needs for the "submit" completion rule (0 is treated as 1). */
  completionPosts: z.number().int().min(0).max(100).default(1),
});

export function registerForumType() {
  registerActivityType({
    type: "forum",
    label: "Forum",
    settings: forumSettings,
    async create(tx, ctx, s) {
      const intro = s.intro ? cleanHtml(s.intro) : null;
      const [forum] = await tx
        .insert(forums)
        .values({
          organizationId: ctx.organizationId,
          activityId: ctx.activity.id,
          type: s.type,
          intro,
          subscriptionMode: s.subscriptionMode,
          completionPosts: s.completionPosts,
        })
        .returning();
      if (s.type === "single") {
        // A single-discussion forum is born with its one discussion.
        const [d] = await tx
          .insert(forumDiscussions)
          .values({ organizationId: ctx.organizationId, forumId: forum!.id, userId: ctx.userId, title: ctx.activity.name })
          .returning();
        await tx.insert(forumPosts).values({
          organizationId: ctx.organizationId,
          discussionId: d!.id,
          userId: ctx.userId,
          message: intro ?? ctx.activity.description ?? `<p>${escapeText(ctx.activity.name)}</p>`,
        });
      }
    },
    async update(tx, ctx, s) {
      const forum = await forumOf(tx, ctx.activity.id);
      if (s.type && s.type !== forum.type && (s.type === "single" || forum.type === "single")) {
        throw badRequest("A forum cannot be converted to or from the single-discussion type");
      }
      const patch: Partial<typeof forums.$inferInsert> = {};
      if (s.type !== undefined) patch.type = s.type;
      if (s.intro !== undefined) patch.intro = s.intro ? cleanHtml(s.intro) : null;
      if (s.subscriptionMode !== undefined) patch.subscriptionMode = s.subscriptionMode;
      if (s.completionPosts !== undefined) patch.completionPosts = s.completionPosts;
      if (Object.keys(patch).length) await tx.update(forums).set(patch).where(eq(forums.id, forum.id));
    },
    async load(tx, activity) {
      const [f] = await tx.select().from(forums).where(eq(forums.activityId, activity.id)).limit(1);
      if (!f) return null;
      return { type: f.type, intro: f.intro, subscriptionMode: f.subscriptionMode, completionPosts: f.completionPosts };
    },
  });
}

function escapeText(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export async function forumOf(tx: DB, activityId: string) {
  return must((await tx.select().from(forums).where(eq(forums.activityId, activityId)).limit(1))[0], "Forum");
}

/**
 * Loads a forum the user can view, plus everything needed for permission and
 * group-mode decisions. Users with forum:moderate or course:view_hidden see
 * (and post to) all groups.
 */
export async function loadForum(tx: DB, req: FastifyRequest, activityId: string) {
  const me = requireUser(req);
  const { activity, course } = await loadActivity(tx, req, activityId, { type: "forum", capability: "forum:view" });
  const forum = await forumOf(tx, activity.id);
  const canModerate = await hasCapability(tx, req, "forum:moderate", activity.contextId);
  const allGroups = canModerate || (await hasCapability(tx, req, "course:view_hidden", activity.contextId));
  const groupMode = (["separate", "visible"].includes(activity.groupMode) ? activity.groupMode : "none") as GroupMode;
  const myGroupIds = groupMode === "none" ? [] : await userGroupIds(tx, course.id, me.id);
  return { me, activity, course, forum, canModerate, allGroups, groupMode, myGroupIds };
}
export type ForumCtx = Awaited<ReturnType<typeof loadForum>>;

/** Separate groups: non-privileged users only see "all participants" discussions and their own groups'. */
export function canSeeDiscussion(ctx: Pick<ForumCtx, "groupMode" | "allGroups" | "myGroupIds">, d: Pick<DiscussionRow, "groupId">) {
  if (ctx.groupMode !== "separate" || ctx.allGroups) return true;
  return d.groupId === null || ctx.myGroupIds.includes(d.groupId);
}

/** Visible/separate groups: non-privileged users only post in their own groups (or all-participant threads when replying). */
export function canPostInDiscussion(ctx: Pick<ForumCtx, "groupMode" | "allGroups" | "myGroupIds">, d: Pick<DiscussionRow, "groupId">) {
  if (ctx.groupMode === "none" || ctx.allGroups) return true;
  return d.groupId === null || ctx.myGroupIds.includes(d.groupId);
}

export async function loadDiscussion(tx: DB, ctx: ForumCtx, discussionId: string) {
  const [d] = await tx
    .select()
    .from(forumDiscussions)
    .where(and(eq(forumDiscussions.id, discussionId), eq(forumDiscussions.forumId, ctx.forum.id)))
    .limit(1);
  if (!d || !canSeeDiscussion(ctx, d)) throw notFound("Discussion");
  return d;
}

/** Q&A forums: learners must post in a discussion before they can see others' replies. */
export async function qandaHidden(tx: DB, ctx: ForumCtx, discussionId: string) {
  if (ctx.forum.type !== "qanda" || ctx.canModerate) return false;
  const [mine] = await tx
    .select({ id: forumPosts.id })
    .from(forumPosts)
    .where(and(eq(forumPosts.discussionId, discussionId), eq(forumPosts.userId, ctx.me.id), isNull(forumPosts.deletedAt)))
    .limit(1);
  return !mine;
}

export function canEditPost(ctx: Pick<ForumCtx, "canModerate" | "me">, post: Pick<PostRow, "userId" | "createdAt" | "deletedAt">, now = Date.now()) {
  if (post.deletedAt) return false;
  if (ctx.canModerate) return true;
  return post.userId === ctx.me.id && now - post.createdAt.getTime() <= EDIT_WINDOW_MS;
}

export function canDeletePost(ctx: Pick<ForumCtx, "canModerate" | "me">, post: Pick<PostRow, "userId" | "deletedAt">, hasLiveReplies: boolean) {
  if (post.deletedAt) return false;
  if (ctx.canModerate) return true;
  return post.userId === ctx.me.id && !hasLiveReplies;
}

/**
 * Builds the visible post list of a discussion: deleted posts are kept only as
 * placeholders when they still have visible replies.
 */
export function visiblePosts<P extends Pick<PostRow, "id" | "parentId" | "deletedAt">>(posts: P[]) {
  const keep = new Set<string>();
  // Children are created after their parents, so a reverse pass sees descendants first.
  for (let i = posts.length - 1; i >= 0; i--) {
    const p = posts[i]!;
    if (!p.deletedAt || keep.has(p.id)) {
      keep.add(p.id);
      if (p.parentId) keep.add(p.parentId);
    }
  }
  return posts.filter((p) => keep.has(p.id));
}

/** Count of a user's live posts in a forum (for the completion rule). */
export async function userPostCount(tx: DB, forumId: string, userId: string) {
  const rows = await tx
    .select({ id: forumPosts.id })
    .from(forumPosts)
    .innerJoin(forumDiscussions, eq(forumDiscussions.id, forumPosts.discussionId))
    .where(and(eq(forumDiscussions.forumId, forumId), eq(forumPosts.userId, userId), isNull(forumPosts.deletedAt)));
  return rows.length;
}

export async function isSubscribed(tx: DB, forum: ForumRow, userId: string) {
  if (forum.subscriptionMode === "forced") return true;
  if (forum.subscriptionMode === "disabled") return false;
  const [s] = await tx
    .select({ id: forumSubscriptions.id })
    .from(forumSubscriptions)
    .where(and(eq(forumSubscriptions.forumId, forum.id), eq(forumSubscriptions.userId, userId)))
    .limit(1);
  return !!s;
}

/**
 * Notifies about a new post. News forums announce new discussions to every
 * participant; otherwise subscribers are notified (everyone in forced mode).
 * In separate-groups mode a group discussion only reaches that group and staff.
 */
export async function notifyNewPost(
  tx: DB,
  input: {
    activity: ActivityRow;
    course: { id: string; contextId: string };
    forum: ForumRow;
    discussion: DiscussionRow;
    authorId: string;
    message: string;
    isNewDiscussion: boolean;
  },
) {
  const { activity, course, forum, discussion } = input;
  const announcement = forum.type === "news" && input.isNewDiscussion;
  let ids: string[];
  const participants = await activeParticipantIds(tx, course.id);
  if (announcement || forum.subscriptionMode === "forced") {
    ids = participants;
  } else if (forum.subscriptionMode === "disabled") {
    ids = [];
  } else {
    const subs = await tx.select({ userId: forumSubscriptions.userId }).from(forumSubscriptions).where(eq(forumSubscriptions.forumId, forum.id));
    const active = new Set(participants);
    ids = subs.map((s) => s.userId).filter((id) => active.has(id));
  }
  if (activity.groupMode === "separate" && discussion.groupId && ids.length) {
    const members = await tx.select({ userId: groupMembers.userId }).from(groupMembers).where(eq(groupMembers.groupId, discussion.groupId));
    const allowed = new Set([...members.map((m) => m.userId), ...(await staffIds(tx, course))]);
    ids = ids.filter((id) => allowed.has(id));
  }
  ids = ids.filter((id) => id !== input.authorId);
  if (!ids.length) return;
  await notify(tx, {
    organizationId: activity.organizationId,
    userIds: ids,
    type: announcement ? "announcement" : "forum_post",
    title: announcement ? `${activity.name}: ${discussion.title}` : `New post in ${activity.name}: ${discussion.title}`,
    body: htmlExcerpt(input.message),
    link: `/activities/${activity.id}/forum/${discussion.id}`,
  });
}

/** Rejects posting in a discussion the user can see but may not write in. */
export function assertCanReply(ctx: ForumCtx, d: DiscussionRow) {
  if (d.locked) throw forbidden("This discussion is locked");
  if (!canPostInDiscussion(ctx, d)) throw forbidden("You can only post in your own group's discussions");
}

export async function liveChildIds(tx: DB, postIds: string[]) {
  if (!postIds.length) return new Set<string>();
  const rows = await tx
    .select({ parentId: forumPosts.parentId })
    .from(forumPosts)
    .where(and(inArray(forumPosts.parentId, postIds), isNull(forumPosts.deletedAt)));
  return new Set(rows.map((r) => r.parentId!));
}
