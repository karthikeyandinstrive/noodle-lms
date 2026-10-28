import type { LmsModule } from "../../core/types";
import { capabilities } from "./capabilities";
import { routes } from "./routes";
import { setupScorm } from "./service";

export const scormModule: LmsModule = {
  name: "scorm",
  basePath: "/scorm",
  routes,
  capabilities,
  setup: setupScorm,
};
