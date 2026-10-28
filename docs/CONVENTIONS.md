# Engineering conventions

How code in this repo is structured. Read this before adding or changing a module.

## Layout

```
apps/api            Fastify REST API (TypeScript, ESM)
  src/core/         cross-cutting: auth, tenant, rbac, files, storage, events, notify, audit, errors, schemas
  src/modules/<m>/  one folder per feature module (Moodle "plugin" equivalent)
    index.ts        exports the LmsModule { name, basePath, routes, capabilities, setup? }
    routes.ts       HTTP routes (Zod schemas → validation + OpenAPI)
    service.ts      business logic, reusable by other modules
    capabilities.ts capabilities this module checks (must exist in @lms/rbac)
  src/modules/index.ts  registry of all modules
apps/web            Next.js 16 app (App Router, client-rendered pages, TanStack Query, shadcn/ui on Base UI)
  src/app/(auth)    sign-in flows          src/app/(app)  signed-in app (sidebar shell)
  src/features/<m>/ UI for a module        src/components/ shared UI    src/lib/ api client, session, types
packages/db         Drizzle schema (src/schema/*), migrations, client, RLS, seed
packages/rbac       capability catalogue + permission resolution (pure, unit-tested)
```

## API rules

1. **Every route has a full Zod schema**: `params`, `querystring`, `body`, and `response` for each status.
   Responses are serialized through the schema, so fields that aren't declared are never leaked.
   Add `tags` and `summary` (they drive `/api-docs`).
2. **Tenancy.** All tenant data access goes through `req.tenant(async (tx) => { ... })`. It opens a
   transaction with Row Level Security scoped to the request's organization. Inside a `tx`:
   - pass `tx` down to every helper; **never** call `req.tenant`, `withTenant` or `systemDb` again (that nests transactions and deadlocks the embedded dev DB);
   - every insert must set `organizationId: req.org.id` (or the parent row's `organizationId`).
3. **Authorization.** `requireUser(req)` for any signed-in route. Then check a capability *in the
   right context* with `requireCapability(tx, req, cap, contextId)` / `hasCapability(...)` from
   `core/rbac`. Contexts: system → category → course → activity. Use the helpers:
   - `loadCourse(tx, req, courseId)` / `loadCourseWith(tx, req, courseId, cap)` (modules/courses/service)
   - `loadActivity(tx, req, activityId, { type, capability })` (modules/activities/service). Returns `{ activity, course, canEdit }` and enforces visibility and availability.
   Missing **or forbidden** resources return 404 (`must()` / `notFound()`), so their existence isn't revealed.
   Always check **ownership** for per-user data (IDOR): a student can only read their own submissions/attempts unless they hold the grader capability.
4. **Events.** After the transaction commits, `await emit("event.name", payload)` (core/events).
   Subscribe in your module's `setup()` with `on("event.name", async (tx, p) => …)`. Handlers get their own tenant transaction.
   Never emit inside `req.tenant(...)`.
5. **Grades.** Gradable activity types implement `grading()` in their `ActivityTypeHandler`. To record a learner's grade, call
   `pushGrade(tx, {...})` from `modules/gradebook/service` and **emit the returned payload** as `grade.updated` after commit.
6. **Activity types.** Register in `setup()` via `registerActivityType({ type, label, settings: z.object(...), create, update, load, grading? })`.
   The generic activities API (`POST /courses/:courseId/activities`, `PATCH /activities/:id`) calls these. `load` must not expose answers or secrets to students.
   Module-specific routes live under the module's basePath (e.g. `/api/v1/assignments/:activityId/submissions`).
7. **Completion.** Emit `activity.submitted` when a learner fulfils a "submit" rule (assignment submitted, quiz attempt finished, forum post, workshop submission, attendance present, interactive completed, video joined).
   The completion module handles view/submit/grade/pass rules from `activity.viewed`, `activity.submitted` and `grade.updated`.
8. **Files.** Clients upload via `POST /files/uploads` → PUT → `POST /files/:id/complete` (component "draft").
   When attaching, verify with `assertOwnFiles(tx, req, ids)`, then re-tag rows (`component`, `area`, `itemId`, `contextId`) and register an access rule in `setup()` with
   `registerFileAccess(component, async (tx, req, file) => boolean)`. Server-generated files use `storeBuffer`.
9. **User HTML** (descriptions, posts, feedback) goes through `cleanHtml()` before storage. The web app renders it with `<HtmlContent>`.
10. **Audit** admin/teacher actions that change permissions, grades, money or configuration with `audit(tx, req, action, target, meta)`. Never log secrets.
11. **Notifications**: `notify(tx, { organizationId, userIds, type, title, body, link })` (core/notify). Types are listed in `NOTIFICATION_TYPES`.
12. **Errors**: throw `AppError` helpers (`badRequest`, `forbidden`, `notFound`, `conflict`). Don't return error objects manually.
13. **Rate limits**: add `config: { rateLimit: { max, timeWindow } }` to credential, payment and expensive endpoints.
14. Shared Zod helpers live in `core/schemas.ts` (`zId`, `zDate`, `zDateInput`, `zPagination`, `paged()`, `ok`/`zOk`). Date fields in responses use `zDate` / `zNullableDate` (JS `Date` from Drizzle).
15. Numeric grade columns are `numeric(..., mode: "number")`, so they're plain numbers in TS.

## Web rules

- Pages are client components (`"use client"`). Read route params with `useParams()` and query strings with `window.location.search` inside an effect, or with `useSearchParams` wrapped in `<Suspense>`.
- Data: TanStack Query + `api()` from `@/lib/api` (same-origin `/api/v1`). Mutations invalidate the related query keys.
  Reuse `useCourse()` (features/courses/use-course) and `useActivity()` (features/activities/use-activity).
- UI: shadcn components in `@/components/ui` are built on **Base UI**. For polymorphism use the `render` prop
  (`<Button render={<Link href="/x" />}>…</Button>`), **not** `asChild`.
- Shared helpers in `@/components/common`: `PageHeader`, `QueryState`, `EmptyState`, `ErrorAlert`, `HtmlContent`, `formatDate`, `fullName`. Use `FileInput`/`MultiFileInput` for uploads and `toast` from `sonner` for feedback.
- Show actions based on capabilities returned by the API (`activity.capabilities`, `course.capabilities`, `useSession().can()`). The server always re-checks.
- Activity UIs implement `ActivityTypeUI` (`features/activities/types.ts`) in `features/<type>/index.tsx`: `View` (the learner/teacher page body) and `SettingsFields` (controlled form for `settings`).
- Mobile-first: layouts must work at 360px wide. Use semantic HTML, labels, `aria-label` on icon buttons, and keyboard-accessible controls.
