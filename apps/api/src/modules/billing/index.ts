import type { LmsModule } from "../../core/types";
import { capabilities } from "./capabilities";
import { routes } from "./routes";
import { setup } from "./service";

export const billingModule: LmsModule = {
  name: "billing",
  basePath: "/billing",
  routes,
  capabilities,
  setup,
};
