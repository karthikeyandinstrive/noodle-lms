import type { LmsModule } from "../../core/types";
import { capabilities } from "./capabilities";
import { routes } from "./routes";
import { registerWorkshop } from "./service";

export const workshopModule: LmsModule = {
  name: "workshop",
  basePath: "/workshops",
  routes,
  capabilities,
  setup() {
    registerWorkshop();
  },
};
