import type { LmsModule } from "../../core/types";
import { capabilities } from "./capabilities";
import { subscribeWithFollowUps } from "./follow-ups";
import { routes } from "./routes";
import { stateForEvent, stateForGrade, type CompletionRule } from "./rules";
import { applyAutomatic, trackedActivity } from "./service";

export const completionModule: LmsModule = {
  name: "completion",
  basePath: "/completion",
  routes,
  capabilities,
  setup() {
    // Follow-up events (activity.completed, course.completed) are emitted after the subscriber's
    // transaction commits — see follow-ups.ts for why they cannot be emitted from inside the handler.
    subscribeWithFollowUps("activity.viewed", async (tx, p) => {
      const row = await trackedActivity(tx, p.activityId);
      if (!row) return [];
      const state = stateForEvent(row.activity.completionRule as CompletionRule, "viewed");
      return applyAutomatic(tx, { activityId: p.activityId, userId: p.userId, state, viewed: true });
    });

    subscribeWithFollowUps("activity.submitted", async (tx, p) => {
      const row = await trackedActivity(tx, p.activityId);
      if (!row) return [];
      const state = stateForEvent(row.activity.completionRule as CompletionRule, "submitted");
      return state ? applyAutomatic(tx, { activityId: p.activityId, userId: p.userId, state }) : [];
    });

    subscribeWithFollowUps("grade.updated", async (tx, p) => {
      if (!p.activityId) return [];
      const row = await trackedActivity(tx, p.activityId);
      if (!row) return [];
      const state = stateForGrade(row.activity.completionRule as CompletionRule, p.finalGrade, p.gradePass);
      return state ? applyAutomatic(tx, { activityId: p.activityId, userId: p.userId, state }) : [];
    });
  },
};
