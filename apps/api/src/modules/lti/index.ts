import type { LmsModule } from "../../core/types";
import { capabilities } from "./capabilities";
import { routes } from "./routes";
import { setupLtiActivity } from "./service";

export const ltiModule: LmsModule = {
  name: "lti",
  basePath: "/lti",
  routes,
  capabilities,
  setup: setupLtiActivity,
};
