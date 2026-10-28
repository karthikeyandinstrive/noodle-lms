import type { LmsModule } from "../../core/types";
import { capabilities } from "./capabilities";
import { routes } from "./routes";
import { setupVideo } from "./service";

export const videoModule: LmsModule = {
  name: "video",
  basePath: "/video",
  routes,
  capabilities,
  setup: setupVideo,
};
