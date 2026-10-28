import type { LmsModule } from "../../core/types";
import { capabilities } from "./capabilities";
import { routes } from "./routes";
import { setupBadges } from "./service";

export const badgesModule: LmsModule = {
  name: "badges",
  basePath: "/badges",
  routes,
  capabilities,
  setup: setupBadges,
};
