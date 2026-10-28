import type { LmsModule } from "../../core/types";
import { capabilities } from "./capabilities";
import { routes } from "./routes";

export const calendarModule: LmsModule = {
  name: "calendar",
  basePath: "/calendar",
  routes,
  capabilities,
};
