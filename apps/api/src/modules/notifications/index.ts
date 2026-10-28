import type { LmsModule } from "../../core/types";
import { capabilities } from "./capabilities";
import { routes } from "./routes";

export const notificationsModule: LmsModule = {
  name: "notifications",
  basePath: "/notifications",
  routes,
  capabilities,
};
