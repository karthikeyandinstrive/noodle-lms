import type { LmsModule } from "../../core/types";
import { routes } from "./routes";

export const activitiesModule: LmsModule = {
  name: "activities",
  basePath: "/",
  routes,
  capabilities: ["activity:create", "activity:update", "activity:delete", "activity:grade"],
};
