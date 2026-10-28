import {
  boolean,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { createdAt, id, orgId, ts, updatedAt } from "./_common";
import { organizations, users } from "./core";
import { activities, courses } from "./courses";

const grade = () => numeric({ precision: 10, scale: 5, mode: "number" });

export const aggregation = pgEnum("grade_aggregation", ["mean", "weighted_mean", "sum", "highest", "lowest", "median"]);

/** Each course has one root category (parentId = null) created with the course. */
export const gradeCategories = pgTable("grade_categories", {
  id: id(),
  organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
  courseId: uuid()
    .notNull()
    .references(() => courses.id, { onDelete: "cascade" }),
  parentId: uuid().references((): AnyPgColumn => gradeCategories.id, { onDelete: "cascade" }),
  name: text().notNull(),
  aggregation: aggregation().notNull().default("weighted_mean"),
  dropLowest: integer().notNull().default(0),
  createdAt: createdAt(),
});

export const gradeItemType = pgEnum("grade_item_type", ["activity", "manual", "category", "course"]);

export const gradeItems = pgTable(
  "grade_items",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    courseId: uuid()
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    categoryId: uuid().references(() => gradeCategories.id, { onDelete: "set null" }),
    type: gradeItemType().notNull(),
    /** Set for activity items; one grade item per gradable activity. */
    activityId: uuid()
      .unique()
      .references(() => activities.id, { onDelete: "cascade" }),
    name: text().notNull(),
    gradeMax: grade().notNull().default(100),
    gradeMin: grade().notNull().default(0),
    gradePass: grade(),
    weight: grade().notNull().default(1),
    hidden: boolean().notNull().default(false),
    locked: boolean().notNull().default(false),
    position: integer().notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("grade_items_course_idx").on(t.courseId)],
);

export const gradeGrades = pgTable(
  "grade_grades",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    itemId: uuid()
      .notNull()
      .references(() => gradeItems.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Grade pushed by the activity. */
    rawGrade: grade(),
    /** Grade shown in the gradebook (raw, or teacher override). */
    finalGrade: grade(),
    overridden: boolean().notNull().default(false),
    feedback: text(),
    gradedBy: uuid(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("grade_grades_uq").on(t.itemId, t.userId)],
);

export const gradeHistory = pgTable("grade_history", {
  id: id(),
  organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
  itemId: uuid().notNull(),
  userId: uuid().notNull(),
  oldGrade: grade(),
  newGrade: grade(),
  source: text().notNull(),
  changedBy: uuid(),
  changedAt: ts().notNull().defaultNow(),
});
