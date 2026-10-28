import type { LmsModule } from "../../core/types";
import { capabilities } from "./capabilities";
import { routes } from "./routes";
import { registerAssignmentType } from "./service";

export const assignmentModule: LmsModule = {
  name: "assignment",
  basePath: "/assignments",
  routes,
  capabilities,
  setup() {
    registerAssignmentType();
  },
};
