import type { LmsModule } from "../../core/types";
import { capabilities } from "./capabilities";
import { routes } from "./routes";
import { setupBackup } from "./service";

export const backupModule: LmsModule = {
  name: "backup",
  basePath: "/backups",
  routes,
  capabilities,
  setup: setupBackup,
};
