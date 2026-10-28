import { aliasedTable, and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { forumDiscussions, forumPosts, forumSubscriptions, groups, users, type DB } from "@lms/db";
import { z } from "zod";
import { audit } from "../../core/audit";
import { badRequest, forbidden, notFound } from "../../core/errors";
import { emit } from "../../core/events";
import { hasCapability, requireCapability } from "../../core/rbac";
import { cleanHtml } from "../../core/sanitize";
import { offset, ok, paged, zDate, zId, zNullableDate, zOk, zPagination } from "../../core/schemas";
import { courseGroups, groupInCourse, htmlExcerpt, likeEscape } from "./people";
import {
  assertCanReply,
  canDeletePost,
  canEditPost,
  canPostInDiscussion,
  isSubscribed,
  liveChildIds,
  loadDiscussion,
  loadForum,
  notifyNewPost,
  qandaHidden,
  userPostCount,
  visiblePosts,
  type ForumCtx,
} from "./service";

const tags = ["Forum"];
const zAuthor = z.object({ id: zId, firstName: z.string(), lastName: z.string() });
const zMessage = z.string().trim().min(1).max(100_000);

const zForumInfo = z.object({
  activityId: zId,
  type: z.enum(["general", "news", "qanda", "single"]),
  intro: z.string().nullable(),
  subscriptionMode: z.enum(["optional", "forced", "disabled"]),
  completionPosts: z.number().int(),
  subscribed: z.boolean(),
  groupMode: z.enum(["none", "separate", "visible"]),
  /** Groups the user may start discussions in (empty when group mode is off). */
  groups: z.array(z.object({ id: zId, name: z.string() })),
  canModerate: z.boolean(),
  canStartDiscussion: z.boolean(),
  canReply: z.boolean(),
  singleDiscussionId: zId.nullable(),
  myPostCount: z.number().int(),
});

const zDiscussionSummary = z.object({
  id: zId,
  title: z.string(),
  pinned: z.boolean(),
  locked: z.boolean(),
  groupId: zId.nullable(),
  groupName: z.string().nullable(),
  author: zAuthor,
  createdAt: zDate,
  lastPostAt: zDate,
  replyCount: z.number().int(),
});

const zPost = z.object({
  id: zId,
  parentId: zId.nullable(),
  author: zAuthor,
  message: z.string(),
  createdAt: zDate,
  updatedAt: zNullableDate,
  deleted: z.boolean(),
  canEdit: z.boolean(),
  canDelete: z.boolean(),
});

const zDiscussionDetail = zDiscussionSummary.extend({
  posts: z.array(zPost),
  canReply: z.boolean(),
  /** Q&A: other learners' replies are hidden until the user posts. */
  repliesHidden: z.boolean(),
});

const params = z.object({ activityId: zId });
const discussionParams = params.extend({ discussionId: zId });
const postParams = params.extend({ postId: zId });

/** SQL visibility filter for discussions under separate groups. */
function discussionVisibility(ctx: ForumCtx): SQL | undefined {
  if (ctx.groupMode !== "separate" || ctx.allGroups) return undefined;
  return ctx.myGroupIds.length
    ? or(isNull(forumDiscussions.groupId), inArray(forumDiscussions.groupId, ctx.myGroupIds))
    : isNull(forumDiscussions.groupId);
}

async function canStart(tx: DB, req: FastifyRequest, ctx: ForumCtx) {
  if (ctx.forum.type === "single") return false;
  if (!(await hasCapability(tx, req, "forum:start_discussion", ctx.activity.contextId))) return false;
  if (ctx.forum.type === "news" && !(await hasCapability(tx, req, "forum:post_news", ctx.activity.contextId))) return false;
  return ctx.groupMode === "none" || ctx.allGroups || ctx.myGroupIds.length > 0;
}

async function canReplyIn(tx: DB, req: FastifyRequest, ctx: ForumCtx) {
  if (!(await hasCapability(tx, req, "forum:reply", ctx.activity.contextId))) return false;
  // Announcements are one-way unless the user may post news.
  if (ctx.forum.type === "news" && !(await hasCapability(tx, req, "forum:post_news", ctx.activity.contextId))) return false;
  return true;
}

export const routes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/:activityId",
    { schema: { tags, summary: "Forum settings, my subscription and what I can do", params, response: { 200: zForumInfo } } },
    (req) =>
      req.tenant(async (tx) => {
        const ctx = await loadForum(tx, req, req.params.activityId);
        const all = ctx.groupMode === "none" ? [] : await courseGroups(tx, ctx.course.id);
        const [single] =
          ctx.forum.type === "single"
            ? await tx.select({ id: forumDiscussions.id }).from(forumDiscussions).where(eq(forumDiscussions.forumId, ctx.forum.id)).orderBy(asc(forumDiscussions.createdAt)).limit(1)
            : [];
        return {
          activityId: ctx.activity.id,
          type: ctx.forum.type,
          intro: ctx.forum.intro,
          subscriptionMode: ctx.forum.subscriptionMode as "optional" | "forced" | "disabled",
          completionPosts: ctx.forum.completionPosts,
          subscribed: await isSubscribed(tx, ctx.forum, ctx.me.id),
          groupMode: ctx.groupMode,
          groups: ctx.allGroups ? all : all.filter((g) => ctx.myGroupIds.includes(g.id)),
          canModerate: ctx.canModerate,
          canStartDiscussion: await canStart(tx, req, ctx),
          canReply: await canReplyIn(tx, req, ctx),
          singleDiscussionId: single?.id ?? null,
          myPostCount: await userPostCount(tx, ctx.forum.id, ctx.me.id),
        };
      }),
  );

  app.get(
    "/:activityId/discussions",
    {
      schema: {
        tags,
        summary: "List discussions (pinned first, then most recent activity)",
        params,
        querystring: zPagination.extend({ search: z.string().trim().max(200).optional() }),
        response: { 200: paged(zDiscussionSummary) },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        const ctx = await loadForum(tx, req, req.params.activityId);
        const q = req.query;
        const stats = tx
          .select({ discussionId: forumPosts.discussionId, n: sql<number>`count(*)::int`.as("n") })
          .from(forumPosts)
          .where(isNull(forumPosts.deletedAt))
          .groupBy(forumPosts.discussionId)
          .as("stats");
        const where = and(
          eq(forumDiscussions.forumId, ctx.forum.id),
          discussionVisibility(ctx),
          q.search ? ilike(forumDiscussions.title, `%${likeEscape(q.search)}%`) : undefined,
        );
        const rows = await tx
            .select({ d: forumDiscussions, n: stats.n, u: { id: users.id, firstName: users.firstName, lastName: users.lastName }, groupName: groups.name })
            .from(forumDiscussions)
            .innerJoin(stats, eq(stats.discussionId, forumDiscussions.id))
            .innerJoin(users, eq(users.id, forumDiscussions.userId))
            .leftJoin(groups, eq(groups.id, forumDiscussions.groupId))
            .where(where)
            .orderBy(desc(forumDiscussions.pinned), desc(forumDiscussions.lastPostAt))
            .limit(q.pageSize)
            .offset(offset(q));
        const [total] = await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(forumDiscussions)
            .innerJoin(stats, eq(stats.discussionId, forumDiscussions.id))
            .where(where);
        return {
          items: rows.map((r) => ({
            id: r.d.id,
            title: r.d.title,
            pinned: r.d.pinned,
            locked: r.d.locked,
            groupId: r.d.groupId,
            groupName: r.groupName ?? null,
            author: r.u,
            createdAt: r.d.createdAt,
            lastPostAt: r.d.lastPostAt,
            replyCount: Math.max(0, r.n - 1),
          })),
          total: total?.n ?? 0,
          page: q.page,
          pageSize: q.pageSize,
        };
      }),
  );

  app.post(
    "/:activityId/discussions",
    {
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        tags,
        summary: "Start a discussion",
        params,
        body: z.object({ title: z.string().trim().min(1).max(255), message: zMessage, groupId: zId.nullable().optional(), pinned: z.boolean().optional() }),
        response: { 201: z.object({ id: zId }) },
      },
    },
    async (req, reply) => {
      const out = await req.tenant(async (tx) => {
        const ctx = await loadForum(tx, req, req.params.activityId);
        if (ctx.forum.type === "single") throw badRequest("This forum has a single discussion");
        await requireCapability(tx, req, "forum:start_discussion", ctx.activity.contextId);
        if (ctx.forum.type === "news") await requireCapability(tx, req, "forum:post_news", ctx.activity.contextId);

        let groupId: string | null = req.body.groupId ?? null;
        if (ctx.groupMode !== "none") {
          if (ctx.allGroups) {
            if (groupId && !(await groupInCourse(tx, groupId, ctx.course.id))) throw badRequest("Unknown group");
          } else {
            if (!ctx.myGroupIds.length) throw forbidden("You must be in a group to start a discussion");
            groupId ??= ctx.myGroupIds[0]!;
            if (!ctx.myGroupIds.includes(groupId)) throw forbidden("You can only post in your own groups");
          }
        } else {
          groupId = null;
        }
        if (req.body.pinned && !ctx.canModerate) throw forbidden("Only moderators can pin discussions");

        const message = cleanHtml(req.body.message);
        if (!message.trim()) throw badRequest("Message is empty");
        const [discussion] = await tx
          .insert(forumDiscussions)
          .values({ organizationId: req.org.id, forumId: ctx.forum.id, userId: ctx.me.id, groupId, title: req.body.title, pinned: !!req.body.pinned })
          .returning();
        const [post] = await tx
          .insert(forumPosts)
          .values({ organizationId: req.org.id, discussionId: discussion!.id, userId: ctx.me.id, message })
          .returning();
        await notifyNewPost(tx, { activity: ctx.activity, course: ctx.course, forum: ctx.forum, discussion: discussion!, authorId: ctx.me.id, message, isNewDiscussion: true });
        const count = await userPostCount(tx, ctx.forum.id, ctx.me.id);
        return { ctx, discussion: discussion!, post: post!, completed: count >= Math.max(1, ctx.forum.completionPosts) };
      });
      const base = { organizationId: req.org.id, activityId: out.ctx.activity.id, courseId: out.ctx.course.id, userId: out.ctx.me.id };
      await emit("forum.discussion_created", { ...base, discussionId: out.discussion.id });
      await emit("forum.post_created", { ...base, discussionId: out.discussion.id, postId: out.post.id });
      if (out.completed) await emit("activity.submitted", base);
      return reply.status(201).send({ id: out.discussion.id });
    },
  );

  app.get(
    "/:activityId/discussions/:discussionId",
    { schema: { tags, summary: "A discussion with its posts (flat list; build the tree from parentId)", params: discussionParams, response: { 200: zDiscussionDetail } } },
    (req) =>
      req.tenant(async (tx) => {
        const ctx = await loadForum(tx, req, req.params.activityId);
        const d = await loadDiscussion(tx, ctx, req.params.discussionId);
        const rows = await tx
          .select({ p: forumPosts, u: { id: users.id, firstName: users.firstName, lastName: users.lastName } })
          .from(forumPosts)
          .innerJoin(users, eq(users.id, forumPosts.userId))
          .where(eq(forumPosts.discussionId, d.id))
          .orderBy(asc(forumPosts.createdAt));
        // A discussion whose posts were all deleted is gone (it's also excluded from the list).
        if (!rows.some((r) => !r.p.deletedAt)) throw notFound("Discussion");
        const hidden = await qandaHidden(tx, ctx, d.id);
        const scoped = hidden ? rows.filter((r) => r.p.parentId === null || r.p.userId === ctx.me.id) : rows;
        const visible = visiblePosts(scoped.map((r) => ({ ...r.p, author: r.u })));
        const liveParents = new Set(rows.filter((r) => !r.p.deletedAt && r.p.parentId).map((r) => r.p.parentId!));
        const [author] = await tx.select({ id: users.id, firstName: users.firstName, lastName: users.lastName }).from(users).where(eq(users.id, d.userId));
        const [group] = d.groupId ? await tx.select({ name: groups.name }).from(groups).where(eq(groups.id, d.groupId)) : [];
        const now = Date.now();
        return {
          id: d.id,
          title: d.title,
          pinned: d.pinned,
          locked: d.locked,
          groupId: d.groupId,
          groupName: group?.name ?? null,
          author: author!,
          createdAt: d.createdAt,
          lastPostAt: d.lastPostAt,
          replyCount: Math.max(0, rows.filter((r) => !r.p.deletedAt).length - 1),
          repliesHidden: hidden,
          canReply: !d.locked && canPostInDiscussion(ctx, d) && (await canReplyIn(tx, req, ctx)),
          posts: visible.map((p) => ({
            id: p.id,
            parentId: p.parentId,
            author: p.author,
            message: p.deletedAt ? "" : p.message,
            createdAt: p.createdAt,
            updatedAt: p.updatedAt && p.updatedAt.getTime() - p.createdAt.getTime() > 1000 ? p.updatedAt : null,
            deleted: !!p.deletedAt,
            canEdit: canEditPost(ctx, p, now),
            canDelete: canDeletePost(ctx, p, liveParents.has(p.id)),
          })),
        };
      }),
  );

  app.patch(
    "/:activityId/discussions/:discussionId",
    {
      schema: {
        tags,
        summary: "Pin / lock a discussion (moderators)",
        params: discussionParams,
        body: z.object({ pinned: z.boolean().optional(), locked: z.boolean().optional() }),
        response: { 200: zOk },
      },
    },
    async (req) => {
      await req.tenant(async (tx) => {
        const ctx = await loadForum(tx, req, req.params.activityId);
        await requireCapability(tx, req, "forum:moderate", ctx.activity.contextId);
        const d = await loadDiscussion(tx, ctx, req.params.discussionId);
        const patch = { ...(req.body.pinned !== undefined ? { pinned: req.body.pinned } : {}), ...(req.body.locked !== undefined ? { locked: req.body.locked } : {}) };
        if (!Object.keys(patch).length) return;
        await tx.update(forumDiscussions).set(patch).where(eq(forumDiscussions.id, d.id));
        await audit(tx, req, "forum.discussion_moderated", { type: "forum_discussion", id: d.id }, patch);
      });
      return ok;
    },
  );

  app.post(
    "/:activityId/discussions/:discussionId/posts",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags,
        summary: "Reply to a post",
        params: discussionParams,
        body: z.object({ parentId: zId, message: zMessage }),
        response: { 201: z.object({ id: zId }) },
      },
    },
    async (req, reply) => {
      const out = await req.tenant(async (tx) => {
        const ctx = await loadForum(tx, req, req.params.activityId);
        await requireCapability(tx, req, "forum:reply", ctx.activity.contextId);
        if (ctx.forum.type === "news") await requireCapability(tx, req, "forum:post_news", ctx.activity.contextId);
        const d = await loadDiscussion(tx, ctx, req.params.discussionId);
        assertCanReply(ctx, d);
        const [parent] = await tx
          .select()
          .from(forumPosts)
          .where(and(eq(forumPosts.id, req.body.parentId), eq(forumPosts.discussionId, d.id), isNull(forumPosts.deletedAt)))
          .limit(1);
        if (!parent) throw notFound("Post");
        // Q&A: before posting, a learner may only reply to the question itself (or their own posts).
        if (parent.parentId && parent.userId !== ctx.me.id && (await qandaHidden(tx, ctx, d.id))) throw notFound("Post");
        const message = cleanHtml(req.body.message);
        if (!message.trim()) throw badRequest("Message is empty");
        const [post] = await tx
          .insert(forumPosts)
          .values({ organizationId: req.org.id, discussionId: d.id, parentId: parent.id, userId: ctx.me.id, message })
          .returning();
        await tx.update(forumDiscussions).set({ lastPostAt: new Date() }).where(eq(forumDiscussions.id, d.id));
        await notifyNewPost(tx, { activity: ctx.activity, course: ctx.course, forum: ctx.forum, discussion: d, authorId: ctx.me.id, message, isNewDiscussion: false });
        const count = await userPostCount(tx, ctx.forum.id, ctx.me.id);
        return { ctx, discussionId: d.id, post: post!, completed: count >= Math.max(1, ctx.forum.completionPosts) };
      });
      const base = { organizationId: req.org.id, activityId: out.ctx.activity.id, courseId: out.ctx.course.id, userId: out.ctx.me.id };
      await emit("forum.post_created", { ...base, discussionId: out.discussionId, postId: out.post.id });
      if (out.completed) await emit("activity.submitted", base);
      return reply.status(201).send({ id: out.post.id });
    },
  );

  async function loadPost(tx: DB, ctx: ForumCtx, postId: string) {
    const [row] = await tx
      .select({ p: forumPosts, d: forumDiscussions })
      .from(forumPosts)
      .innerJoin(forumDiscussions, eq(forumDiscussions.id, forumPosts.discussionId))
      .where(and(eq(forumPosts.id, postId), eq(forumDiscussions.forumId, ctx.forum.id)))
      .limit(1);
    if (!row || row.p.deletedAt) throw notFound("Post");
    await loadDiscussion(tx, ctx, row.d.id); // group visibility
    return row;
  }

  app.patch(
    "/:activityId/posts/:postId",
    {
      schema: {
        tags,
        summary: `Edit a post (own posts within 30 minutes; moderators any time). Editing the first post may also rename the discussion.`,
        params: postParams,
        body: z.object({ message: zMessage, title: z.string().trim().min(1).max(255).optional() }),
        response: { 200: zOk },
      },
    },
    async (req) => {
      await req.tenant(async (tx) => {
        const ctx = await loadForum(tx, req, req.params.activityId);
        const { p, d } = await loadPost(tx, ctx, req.params.postId);
        if (!canEditPost(ctx, p)) throw forbidden(p.userId === ctx.me.id ? "The 30-minute edit window has passed" : "You cannot edit this post");
        if (d.locked && !ctx.canModerate) throw forbidden("This discussion is locked");
        const message = cleanHtml(req.body.message);
        if (!message.trim()) throw badRequest("Message is empty");
        await tx.update(forumPosts).set({ message, updatedAt: new Date() }).where(eq(forumPosts.id, p.id));
        if (req.body.title && p.parentId === null) {
          await tx.update(forumDiscussions).set({ title: req.body.title }).where(eq(forumDiscussions.id, d.id));
        }
        if (p.userId !== ctx.me.id) await audit(tx, req, "forum.post_edited", { type: "forum_post", id: p.id }, { authorId: p.userId });
      });
      return ok;
    },
  );

  app.delete(
    "/:activityId/posts/:postId",
    { schema: { tags, summary: "Delete a post (soft). Own posts only while they have no replies; moderators any.", params: postParams, response: { 200: zOk } } },
    async (req) => {
      await req.tenant(async (tx) => {
        const ctx = await loadForum(tx, req, req.params.activityId);
        const { p } = await loadPost(tx, ctx, req.params.postId);
        const children = await liveChildIds(tx, [p.id]);
        if (!canDeletePost(ctx, p, children.has(p.id))) throw forbidden("You cannot delete this post");
        await tx.update(forumPosts).set({ deletedAt: new Date() }).where(eq(forumPosts.id, p.id));
        if (p.userId !== ctx.me.id) await audit(tx, req, "forum.post_deleted", { type: "forum_post", id: p.id }, { authorId: p.userId });
      });
      return ok;
    },
  );

  app.put(
    "/:activityId/subscription",
    {
      schema: {
        tags,
        summary: "Subscribe to / unsubscribe from forum notifications",
        params,
        body: z.object({ subscribed: z.boolean() }),
        response: { 200: z.object({ subscribed: z.boolean() }) },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        const ctx = await loadForum(tx, req, req.params.activityId);
        const mode = ctx.forum.subscriptionMode;
        if (mode === "forced") {
          if (!req.body.subscribed) throw badRequest("Everyone is subscribed to this forum");
          return { subscribed: true };
        }
        if (mode === "disabled") {
          if (req.body.subscribed) throw badRequest("Subscriptions are disabled for this forum");
          return { subscribed: false };
        }
        if (req.body.subscribed) {
          await tx.insert(forumSubscriptions).values({ organizationId: req.org.id, forumId: ctx.forum.id, userId: ctx.me.id }).onConflictDoNothing();
        } else {
          await tx.delete(forumSubscriptions).where(and(eq(forumSubscriptions.forumId, ctx.forum.id), eq(forumSubscriptions.userId, ctx.me.id)));
        }
        return { subscribed: req.body.subscribed };
      }),
  );

  app.get(
    "/:activityId/search",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        tags,
        summary: "Search posts in this forum (message or discussion title)",
        params,
        querystring: zPagination.extend({ q: z.string().trim().min(2).max(200) }),
        response: {
          200: paged(z.object({ postId: zId, discussionId: zId, discussionTitle: z.string(), author: zAuthor, excerpt: z.string(), createdAt: zDate })),
        },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        const ctx = await loadForum(tx, req, req.params.activityId);
        const q = req.query;
        const pattern = `%${likeEscape(q.q)}%`;
        const mine = aliasedTable(forumPosts, "mine");
        const qanda =
          ctx.forum.type === "qanda" && !ctx.canModerate
            ? or(
                isNull(forumPosts.parentId),
                eq(forumPosts.userId, ctx.me.id),
                sql`exists (select 1 from ${mine} where ${mine.discussionId} = ${forumPosts.discussionId} and ${mine.userId} = ${ctx.me.id} and ${mine.deletedAt} is null)`,
              )
            : undefined;
        const where = and(
          eq(forumDiscussions.forumId, ctx.forum.id),
          isNull(forumPosts.deletedAt),
          discussionVisibility(ctx),
          or(ilike(forumPosts.message, pattern), ilike(forumDiscussions.title, pattern)),
          qanda,
        );
        const rows = await tx
            .select({ p: forumPosts, title: forumDiscussions.title, u: { id: users.id, firstName: users.firstName, lastName: users.lastName } })
            .from(forumPosts)
            .innerJoin(forumDiscussions, eq(forumDiscussions.id, forumPosts.discussionId))
            .innerJoin(users, eq(users.id, forumPosts.userId))
            .where(where)
            .orderBy(desc(forumPosts.createdAt))
            .limit(q.pageSize)
            .offset(offset(q));
        const [total] = await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(forumPosts)
            .innerJoin(forumDiscussions, eq(forumDiscussions.id, forumPosts.discussionId))
            .where(where);
        return {
          items: rows.map((r) => ({
            postId: r.p.id,
            discussionId: r.p.discussionId,
            discussionTitle: r.title,
            author: r.u,
            excerpt: htmlExcerpt(r.p.message, 240),
            createdAt: r.p.createdAt,
          })),
          total: total?.n ?? 0,
          page: q.page,
          pageSize: q.pageSize,
        };
      }),
  );
};
