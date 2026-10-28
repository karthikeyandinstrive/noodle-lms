import { eq } from "drizzle-orm";
import { closeDb, systemDb, type DB } from "./client";
import { bootstrapOrganization, hashPassword } from "./bootstrap";
import { createContext } from "./helpers";
import {
  courseCategories,
  courseSections,
  courses,
  enrolments,
  gradeCategories,
  gradeItems,
  organizations,
  roleAssignments,
  users,
} from "./schema";

/**
 * Development seed: one organization ("default") with an admin, a teacher,
 * two students and a sample course. Idempotent: skips if the org exists.
 * Credentials come from env (SEED_*), with dev-only defaults.
 */
const slug = process.env.DEFAULT_ORG_SLUG ?? "default";
const password = process.env.SEED_PASSWORD ?? "ChangeMe123!";
if (process.env.NODE_ENV === "production" && !process.env.SEED_PASSWORD) {
  throw new Error("Set SEED_PASSWORD when seeding production");
}

const db = await systemDb();
const [existing] = await db.select().from(organizations).where(eq(organizations.slug, slug)).limit(1);
if (existing) {
  console.log(`✓ organization "${slug}" already exists — nothing to seed`);
  await closeDb();
  process.exit(0);
}

await db.transaction(async (t) => {
  const tx = t as unknown as DB;
  const { organization, systemContext, roleIds } = await bootstrapOrganization(tx, {
    name: process.env.SEED_ORG_NAME ?? "Demo Academy",
    slug,
    admin: { email: process.env.SEED_ADMIN_EMAIL ?? "admin@example.com", password, firstName: "Ada", lastName: "Admin" },
  });
  const organizationId = organization.id;
  await tx.update(organizations).set({ settings: { selfRegistration: true } }).where(eq(organizations.id, organizationId));

  const people = [
    { email: "teacher@example.com", firstName: "Tom", lastName: "Teacher" },
    { email: "student1@example.com", firstName: "Sara", lastName: "Student" },
    { email: "student2@example.com", firstName: "Sam", lastName: "Learner" },
  ];
  const passwordHash = await hashPassword(password);
  const created = await tx
    .insert(users)
    .values(people.map((p) => ({ ...p, organizationId, passwordHash, emailVerifiedAt: new Date() })))
    .returning();

  const catId = crypto.randomUUID();
  const catCtx = await createContext(tx, { organizationId, level: "category", instanceId: catId, parentId: systemContext.id });
  await tx.insert(courseCategories).values({ id: catId, organizationId, contextId: catCtx.id, name: "General" });

  const courseId = crypto.randomUUID();
  const courseCtx = await createContext(tx, { organizationId, level: "course", instanceId: courseId, parentId: catCtx.id });
  await tx.insert(courses).values({
    id: courseId,
    organizationId,
    categoryId: catId,
    contextId: courseCtx.id,
    fullname: "Introduction to Web Development",
    shortname: "WEB101",
    summary: "<p>HTML, CSS and JavaScript fundamentals.</p>",
    selfEnrol: "open",
  });
  await tx.insert(courseSections).values([
    { organizationId, courseId, title: "General", position: 0 },
    { organizationId, courseId, title: "Week 1 — HTML", position: 1 },
    { organizationId, courseId, title: "Week 2 — CSS", position: 2 },
  ]);
  const [root] = await tx.insert(gradeCategories).values({ organizationId, courseId, name: "Course total" }).returning();
  await tx.insert(gradeItems).values({ organizationId, courseId, categoryId: root!.id, type: "course", name: "Course total", position: 10_000 });

  const [teacher, ...students] = created;
  await tx.insert(enrolments).values(created.map((u) => ({ organizationId, courseId, userId: u.id, method: "manual" as const })));
  await tx.insert(roleAssignments).values([
    { organizationId, userId: teacher!.id, roleId: roleIds.get("editing_teacher")!, contextId: courseCtx.id },
    ...students.map((s) => ({ organizationId, userId: s.id, roleId: roleIds.get("student")!, contextId: courseCtx.id })),
  ]);
});

console.log(`✓ seeded organization "${slug}"`);
console.log(`  admin@example.com / teacher@example.com / student1@example.com — password: ${process.env.SEED_PASSWORD ? "(SEED_PASSWORD)" : password}`);
await closeDb();
process.exit(0);
