import type { LmsModule } from "../../core/types";
import { capabilities } from "./capabilities";
import { routes } from "./routes";

export const searchModule: LmsModule = {
  name: "search",
  basePath: "/search",
  routes,
  capabilities,
};
