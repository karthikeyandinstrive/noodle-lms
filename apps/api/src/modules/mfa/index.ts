import type { LmsModule } from "../../core/types";
import { capabilities } from "./capabilities";
import { routes } from "./routes";

export const mfaModule: LmsModule = {
  name: "mfa",
  basePath: "/auth/mfa",
  routes,
  capabilities,
};
