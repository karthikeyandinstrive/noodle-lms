import { addWorkerTick } from "../../core/worker";
import type { LmsModule } from "../../core/types";
import { capabilities } from "./capabilities";
import { routes } from "./routes";
import { SCHEDULER_TICK_MS, runDueTasks } from "./tasks";

let registered = false;

export const schedulerModule: LmsModule = {
  name: "scheduler",
  basePath: "/admin/system",
  routes,
  capabilities,
  setup() {
    // Cron-like tasks (reminders, quiz auto-finish, cleanup) run from the background worker loop.
    // Guarded so building the app twice in one process doesn't register the tick twice.
    if (registered) return;
    registered = true;
    addWorkerTick({ name: "scheduler", everyMs: SCHEDULER_TICK_MS, run: () => runDueTasks() });
  },
};
