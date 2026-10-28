import type { LmsModule } from "../../core/types";
import { routes } from "./routes";

export const authModule: LmsModule = { name: "auth", basePath: "/auth", routes };
