import { on } from "../../core/events";
import type { LmsModule } from "../../core/types";
import { capabilities } from "./capabilities";
import { emitFollowUps } from "./follow-ups";
import { routes } from "./routes";
import { stateForEvent, stateForGrade, type CompletionRule } from "./rules";
import { applyAutomatic, reevaluateCourse, trackedActivity } from "./service";

export const completionModule: LmsModule = {
  name: "completion",
  basePath: "/completion",
  routes,
  capabilities,
  setup() {
    // Each subscriber runs in its own tenant transaction and is retried independently, so all of
    // them are idempotent (setActivityCompletion/evaluateCourseCompletion only act on changes).
    // Follow-ups (activity.completed, course.completed) go to the outbox in the same transaction.
    on(
      "activity.viewed",
      async (tx, p) => {
        const row = await trackedActivity(tx, p.activityId);
        if (!row) return;
        const state = stateForEvent(row.activity.completionRule as CompletionRule, "viewed");
        await emitFollowUps(tx, await applyAutomatic(tx, { activityId: p.activityId, userId: p.userId, state, viewed: true }));
      },
      { id: "completion.viewed" },
    );

    on(
      "activity.submitted",
      async (tx, p) => {
        const row = await trackedActivity(tx, p.activityId);
        if (!row) return;
        const state = stateForEvent(row.activity.completionRule as CompletionRule, "submitted");
        if (state) await emitFollowUps(tx, await applyAutomatic(tx, { activityId: p.activityId, userId: p.userId, state }));
      },
      { id: "completion.submitted" },
    );

    on(
      "grade.updated",
      async (tx, p) => {
        if (!p.activityId) return;
        const row = await trackedActivity(tx, p.activityId);
        if (!row) return;
        const state = stateForGrade(row.activity.completionRule as CompletionRule, p.finalGrade, p.gradePass);
        if (state) await emitFollowUps(tx, await applyAutomatic(tx, { activityId: p.activityId, userId: p.userId, state }));
      },
      { id: "completion.grade" },
    );

    // An activity's rule or visibility changed, or it was removed: learners may now have completed
    // every remaining tracked activity.
    on("activity.updated", async (tx, p) => emitFollowUps(tx, await reevaluateCourse(tx, p.courseId, p.activityId)), {
      id: "completion.reevaluate_on_update",
    });
    on("activity.deleted", async (tx, p) => emitFollowUps(tx, await reevaluateCourse(tx, p.courseId)), {
      id: "completion.reevaluate_on_delete",
    });
  },
};
