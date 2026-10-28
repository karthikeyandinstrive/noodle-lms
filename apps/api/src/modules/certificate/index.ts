import type { LmsModule } from "../../core/types";
import { capabilities } from "./capabilities";
import { routes } from "./routes";
import { setupCertificate } from "./service";

export const certificateModule: LmsModule = {
  name: "certificate",
  basePath: "/certificates",
  routes,
  capabilities,
  setup: setupCertificate,
};
