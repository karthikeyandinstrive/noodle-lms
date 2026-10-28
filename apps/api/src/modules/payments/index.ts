import type { LmsModule } from "../../core/types";
import { capabilities } from "./capabilities";
import { routes } from "./routes";
import { setup } from "./setup";

export const paymentsModule: LmsModule = {
  name: "payments",
  basePath: "/payments",
  routes,
  capabilities,
  setup,
};
