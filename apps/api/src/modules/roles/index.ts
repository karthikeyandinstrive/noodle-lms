import type { LmsModule } from "../../core/types";
import { routes } from "./routes";

export const rolesModule: LmsModule = {
  name: "roles",
  basePath: "/",
  routes,
  capabilities: ["role:manage", "role:assign"],
};
