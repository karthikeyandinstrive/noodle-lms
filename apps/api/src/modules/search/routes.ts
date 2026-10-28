import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { FastifyRequest } from "fastify";
import {
  activities,
  conversationMembers,
  conversations,
  courseSections,
  courses,
  enrolments,
  forumDiscussions,
  forumPosts,
  forums,
  getSystemContext,
  groupMembers,
  groups,
  messages,
  users,
  type DB,
} from "@lms/db";
import { z } from "zod";
import { requireUser } from "../../core/auth";
import { hasCapability, prefetchCapabilities } from "../../core/rbac";
import { zId } from "../../core/schemas";
import { rank, snippet, textMatch } from "./service";

const TYPES = ["courses", "activities", "forum", "users", "messages"] as const;
type SearchType = (typeof TYPES)[number];
const LIMIT = 10;
/** Candidates fetched before per-row permission filtering. */
const CANDIDATES = 40;

const zHit = z.object({
  id: zId,
  title: z.string(),
  snippet: z.string(),
  /** App path to open the result. */
  link: z.string(),
  /** Context line, e.g. the course name. */
  context: z.string().nullable(),
  /** Activity type for activity hits. */
  kind: z.string().nullable(),
});
type Hit = z.infer<typeof zHit>;

type Ctx = { tx: DB; req: FastifyRequest; q: string; systemId: string };

/**
 * Past this many viewable courses the content queries don't list course ids (bind-parameter
 * limits, huge plans): they search everything and drop rows from other courses afterwards.
 * Only staff with organization-wide access get here, so nearly every course is viewable anyway.
 */
const MAX_COURSE_FILTER = 1000;
const inCourses = (viewable: Map<string, unknown>) => (viewable.size > MAX_COURSE_FILTER ? undefined : inArray(activities.courseId, [...viewable.keys()]));

/** Courses whose content the user may view (course:view in the course context). */
async function viewableCourses(c: Ctx) {
  const me = requireUser(c.req);
  let rows: (typeof courses.$inferSelect)[];
  if (await hasCapability(c.tx, c.req, "course:view", c.systemId)) {
    rows = await c.tx.select().from(courses);
  } else {
    rows = await c.tx
      .select({ course: courses })
      .from(enrolments)
      .innerJoin(courses, eq(courses.id, enrolments.courseId))
      .where(and(eq(enrolments.userId, me.id), eq(enrolments.status, "active")))
      .then((r) => r.map((x) => x.course));
  }
  // Staff may see thousands of courses: resolve the per-course checks in bulk.
  await prefetchCapabilities(c.tx, c.req, ["course:view", "course:view_hidden"], rows.map((r) => r.contextId));
  const out: { course: typeof courses.$inferSelect; seeHidden: boolean }[] = [];
  for (const course of rows) {
    if (!(await hasCapability(c.tx, c.req, "course:view", course.contextId))) continue;
    const seeHidden = await hasCapability(c.tx, c.req, "course:view_hidden", course.contextId);
    if (!course.visible && !seeHidden) continue;
    out.push({ course, seeHidden });
  }
  return out;
}

async function searchCourses(c: Ctx): Promise<Hit[]> {
  const title = [sql`${courses.fullname}`, sql`${courses.shortname}`];
  const body = [sql`${courses.summary}`];
  const seeAllHidden = await hasCapability(c.tx, c.req, "course:view_hidden", c.systemId);
  const rows = await c.tx
    .select()
    .from(courses)
    .where(textMatch(c.q, title, body))
    .orderBy(desc(rank(c.q, [...title, ...body])), courses.fullname)
    .limit(CANDIDATES);
  if (!seeAllHidden) await prefetchCapabilities(c.tx, c.req, ["course:view_hidden"], rows.filter((r) => !r.visible).map((r) => r.contextId));
  const hits: Hit[] = [];
  for (const r of rows) {
    if (!r.visible && !seeAllHidden && !(await hasCapability(c.tx, c.req, "course:view_hidden", r.contextId))) continue;
    hits.push({ id: r.id, title: r.fullname, snippet: snippet(r.summary, c.q) || r.shortname, link: `/courses/${r.id}`, context: r.shortname, kind: null });
    if (hits.length >= LIMIT) break;
  }
  return hits;
}

async function searchActivities(c: Ctx, viewable: Awaited<ReturnType<typeof viewableCourses>>): Promise<Hit[]> {
  if (!viewable.length) return [];
  const byId = new Map(viewable.map((v) => [v.course.id, v]));
  const title = [sql`${activities.name}`];
  const body = [sql`${activities.description}`];
  const rows = await c.tx
    .select({ activity: activities, sectionVisible: courseSections.visible })
    .from(activities)
    .innerJoin(courseSections, eq(courseSections.id, activities.sectionId))
    .where(and(inCourses(byId), textMatch(c.q, title, body)))
    .orderBy(desc(rank(c.q, [...title, ...body])), activities.name)
    .limit(CANDIDATES);
  await prefetchCapabilities(c.tx, c.req, ["course:view"], rows.map((r) => r.activity.contextId));
  const hits: Hit[] = [];
  for (const { activity: a, sectionVisible } of rows) {
    const v = byId.get(a.courseId);
    if (!v) continue;
    if ((!a.visible || !sectionVisible) && !v.seeHidden) continue;
    // Activity-level overrides can remove access.
    if (!(await hasCapability(c.tx, c.req, "course:view", a.contextId))) continue;
    hits.push({ id: a.id, title: a.name, snippet: snippet(a.description, c.q), link: `/activities/${a.id}`, context: v.course.fullname, kind: a.type });
    if (hits.length >= LIMIT) break;
  }
  return hits;
}

async function searchForums(c: Ctx, viewable: Awaited<ReturnType<typeof viewableCourses>>): Promise<Hit[]> {
  if (!viewable.length) return [];
  const me = requireUser(c.req);
  const byId = new Map(viewable.map((v) => [v.course.id, v]));
  const title = [sql`${forumDiscussions.title}`];
  const body = [sql`${forumPosts.message}`];
  const rows = await c.tx
    .select({
      discussion: forumDiscussions,
      post: { id: forumPosts.id, message: forumPosts.message, userId: forumPosts.userId, parentId: forumPosts.parentId },
      forumType: forums.type,
      activity: activities,
      sectionVisible: courseSections.visible,
    })
    .from(forumPosts)
    .innerJoin(forumDiscussions, eq(forumDiscussions.id, forumPosts.discussionId))
    .innerJoin(forums, eq(forums.id, forumDiscussions.forumId))
    .innerJoin(activities, eq(activities.id, forums.activityId))
    .innerJoin(courseSections, eq(courseSections.id, activities.sectionId))
    .where(and(inCourses(byId), isNull(forumPosts.deletedAt), textMatch(c.q, title, body)))
    .orderBy(desc(rank(c.q, [...title, ...body])), desc(forumPosts.createdAt))
    .limit(CANDIDATES * 2);

  await prefetchCapabilities(c.tx, c.req, ["course:view", "forum:view", "forum:moderate"], rows.map((r) => r.activity.contextId));
  const access = new Map<string, { ok: boolean; allGroups: boolean; moderate: boolean }>();
  const myGroupsByCourse = new Map<string, Set<string>>();
  const postedIn = new Map<string, boolean>();
  const seen = new Set<string>();
  const hits: Hit[] = [];
  for (const r of rows) {
    if (seen.has(r.discussion.id)) continue;
    const v = byId.get(r.activity.courseId);
    if (!v) continue;
    if ((!r.activity.visible || !r.sectionVisible) && !v.seeHidden) continue;
    let acc = access.get(r.activity.id);
    if (!acc) {
      const ok = (await hasCapability(c.tx, c.req, "course:view", r.activity.contextId)) && (await hasCapability(c.tx, c.req, "forum:view", r.activity.contextId));
      const moderate = ok && (await hasCapability(c.tx, c.req, "forum:moderate", r.activity.contextId));
      acc = { ok, moderate, allGroups: moderate || v.seeHidden };
      access.set(r.activity.id, acc);
    }
    if (!acc.ok) continue;
    // Separate groups: only "all participants" discussions and my groups'.
    if (r.activity.groupMode === "separate" && !acc.allGroups && r.discussion.groupId) {
      let mine = myGroupsByCourse.get(r.activity.courseId);
      if (!mine) {
        mine = new Set(
          (
            await c.tx
              .select({ id: groupMembers.groupId })
              .from(groupMembers)
              .innerJoin(groups, eq(groups.id, groupMembers.groupId))
              .where(and(eq(groupMembers.userId, me.id), eq(groups.courseId, r.activity.courseId)))
          ).map((g) => g.id),
        );
        myGroupsByCourse.set(r.activity.courseId, mine);
      }
      if (!mine.has(r.discussion.groupId)) continue;
    }
    // Q&A: others' replies stay hidden until I posted in the discussion.
    if (r.forumType === "qanda" && !acc.moderate && r.post.parentId && r.post.userId !== me.id) {
      let posted = postedIn.get(r.discussion.id);
      if (posted === undefined) {
        const [mine] = await c.tx
          .select({ id: forumPosts.id })
          .from(forumPosts)
          .where(and(eq(forumPosts.discussionId, r.discussion.id), eq(forumPosts.userId, me.id), isNull(forumPosts.deletedAt)))
          .limit(1);
        posted = !!mine;
        postedIn.set(r.discussion.id, posted);
      }
      if (!posted) continue;
    }
    seen.add(r.discussion.id);
    hits.push({
      id: r.discussion.id,
      title: r.discussion.title,
      snippet: snippet(r.post.message, c.q),
      link: `/activities/${r.activity.id}/forum/${r.discussion.id}`,
      context: `${r.activity.name} · ${v.course.fullname}`,
      kind: "forum",
    });
    if (hits.length >= LIMIT) break;
  }
  return hits;
}

async function searchUsers(c: Ctx): Promise<Hit[]> {
  if (!(await hasCapability(c.tx, c.req, "user:view", c.systemId))) return [];
  const title = [sql`${users.firstName}`, sql`${users.lastName}`, sql`(${users.firstName} || ' ' || ${users.lastName})`, sql`${users.email}`];
  const rows = await c.tx
    .select({ id: users.id, firstName: users.firstName, lastName: users.lastName, email: users.email })
    .from(users)
    .where(and(isNull(users.deletedAt), textMatch(c.q, title, [])))
    .orderBy(users.firstName, users.lastName)
    .limit(LIMIT);
  return rows.map((u) => ({ id: u.id, title: `${u.firstName} ${u.lastName}`, snippet: u.email, link: `/admin/users/${u.id}`, context: null, kind: null }));
}

async function searchMessages(c: Ctx): Promise<Hit[]> {
  const me = requireUser(c.req);
  const body = [sql`${messages.body}`];
  const rows = await c.tx
    .select({ id: messages.id, body: messages.body, conversationId: messages.conversationId, name: conversations.name, type: conversations.type, userId: messages.userId })
    .from(messages)
    .innerJoin(conversationMembers, and(eq(conversationMembers.conversationId, messages.conversationId), eq(conversationMembers.userId, me.id)))
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(and(isNull(messages.deletedAt), textMatch(c.q, [], body)))
    .orderBy(desc(messages.createdAt))
    .limit(LIMIT);
  const authorIds = [...new Set(rows.map((r) => r.userId))];
  const authors = authorIds.length
    ? new Map(
        (await c.tx.select({ id: users.id, firstName: users.firstName, lastName: users.lastName }).from(users).where(inArray(users.id, authorIds))).map((u) => [
          u.id,
          `${u.firstName} ${u.lastName}`,
        ]),
      )
    : new Map<string, string>();
  return rows.map((r) => ({
    id: r.id,
    title: r.name ?? authors.get(r.userId) ?? "",
    snippet: snippet(r.body, c.q),
    link: `/messages?c=${r.conversationId}`,
    context: r.name ? (authors.get(r.userId) ?? null) : null,
    kind: r.type,
  }));
}

export const routes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/",
    {
      schema: {
        tags: ["Search"],
        summary: "Global search across courses, activities, forum posts, users and my messages (permission-aware)",
        querystring: z.object({
          q: z.string().trim().min(1).max(200),
          /** Comma-separated subset of: courses,activities,forum,users,messages */
          types: z.string().max(200).optional(),
        }),
        response: {
          200: z.object({ query: z.string(), groups: z.array(z.object({ type: z.enum(TYPES), items: z.array(zHit) })) }),
        },
      },
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    (req) =>
      req.tenant(async (tx) => {
        requireUser(req);
        const q = req.query.q.replace(/\s+/g, " ");
        const wanted = new Set<SearchType>(
          req.query.types ? (req.query.types.split(",").map((t) => t.trim()).filter((t) => (TYPES as readonly string[]).includes(t)) as SearchType[]) : TYPES,
        );
        const ctx: Ctx = { tx, req, q, systemId: (await getSystemContext(tx, req.org.id)).id };
        const viewable = wanted.has("activities") || wanted.has("forum") ? await viewableCourses(ctx) : [];
        const groupsOut: { type: SearchType; items: Hit[] }[] = [];
        // Sequential: one transaction connection.
        if (wanted.has("courses")) groupsOut.push({ type: "courses", items: await searchCourses(ctx) });
        if (wanted.has("activities")) groupsOut.push({ type: "activities", items: await searchActivities(ctx, viewable) });
        if (wanted.has("forum")) groupsOut.push({ type: "forum", items: await searchForums(ctx, viewable) });
        if (wanted.has("users")) groupsOut.push({ type: "users", items: await searchUsers(ctx) });
        if (wanted.has("messages")) groupsOut.push({ type: "messages", items: await searchMessages(ctx) });
        return { query: q, groups: groupsOut };
      }),
  );
};
