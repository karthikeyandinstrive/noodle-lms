import type { LmsModule } from "../../core/types";
import { routes } from "./routes";

export const coursesModule: LmsModule = {
  name: "courses",
  basePath: "/",
  routes,
  capabilities: [
    "category:manage",
    "course:create",
    "course:view",
    "course:view_hidden",
    "course:update",
    "course:delete",
    "course:enrol_manage",
    "course:view_participants",
    "course:manage_groups",
    "course:self_enrol",
  ],
};
