import type { LmsModule } from "../../core/types";
import { routes } from "./routes";

export const usersModule: LmsModule = {
  name: "users",
  basePath: "/",
  routes,
  capabilities: ["user:view", "user:manage", "cohort:manage"],
};
