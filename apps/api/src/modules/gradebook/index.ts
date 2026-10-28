import { eq } from "drizzle-orm";
import { gradeItems } from "@lms/db";
import { on } from "../../core/events";
import type { LmsModule } from "../../core/types";
import { capabilities } from "./capabilities";
import { routes } from "./routes";
import { isLeafItem, recalculateCourseTotals } from "./service";

export const gradebookModule: LmsModule = {
  name: "gradebook",
  basePath: "/grades",
  routes,
  capabilities,
  setup() {
    // Keep category/course totals in sync. Recalculation writes the total items' grades directly and
    // never emits `grade.updated`, so this subscriber cannot trigger itself.
    on("grade.updated", async (tx, p) => {
      const [item] = await tx.select({ type: gradeItems.type }).from(gradeItems).where(eq(gradeItems.id, p.itemId)).limit(1);
      if (!item || !isLeafItem(item)) return;
      await recalculateCourseTotals(tx, { organizationId: p.organizationId, courseId: p.courseId, userIds: [p.userId] });
    });
    // A deleted activity takes its grade item (and grades) with it, and an updated one may have a new
    // grade range: totals must be recomputed.
    for (const name of ["activity.deleted", "activity.updated"] as const) {
      on(name, async (tx, p) => {
        await recalculateCourseTotals(tx, { organizationId: p.organizationId, courseId: p.courseId });
      });
    }
  },
};
