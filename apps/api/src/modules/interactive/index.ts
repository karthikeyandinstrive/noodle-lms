import type { LmsModule } from "../../core/types";
import { capabilities } from "./capabilities";
import { routes } from "./routes";
import { setupInteractive } from "./service";

export const interactiveModule: LmsModule = {
  name: "interactive",
  basePath: "/interactive",
  routes,
  capabilities,
  setup: setupInteractive,
};
