import type { LmsModule } from "../../core/types";
import { capabilities } from "./capabilities";
import { routes } from "./routes";
import { setupContent } from "./service";

export const contentModule: LmsModule = {
  name: "content",
  basePath: "/content",
  routes,
  capabilities,
  setup: setupContent,
};
