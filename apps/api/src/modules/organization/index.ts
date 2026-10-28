import type { LmsModule } from "../../core/types";
import { routes } from "./routes";

export const organizationModule: LmsModule = {
  name: "organization",
  basePath: "/",
  routes,
  capabilities: ["site:config", "storage:manage", "site:view_audit_log"],
};
