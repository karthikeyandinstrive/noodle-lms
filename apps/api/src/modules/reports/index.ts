import type { LmsModule } from "../../core/types";
import { capabilities } from "./capabilities";
import { routes } from "./routes";

export const reportsModule: LmsModule = {
  name: "reports",
  basePath: "/reports",
  routes,
  capabilities,
};
