import type { LmsModule } from "../../core/types";
import { capabilities } from "./capabilities";
import { routes } from "./routes";
import { registerForumType } from "./service";

export const forumModule: LmsModule = {
  name: "forum",
  basePath: "/forums",
  routes,
  capabilities,
  setup() {
    registerForumType();
  },
};
