import type { LmsModule } from "../../core/types";
import { capabilities } from "./capabilities";
import { routes } from "./routes";

export const ssoModule: LmsModule = {
  name: "sso",
  basePath: "/sso",
  routes,
  capabilities,
};
