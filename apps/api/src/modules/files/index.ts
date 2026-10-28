import type { LmsModule } from "../../core/types";
import { routes } from "./routes";

export const filesModule: LmsModule = { name: "files", basePath: "/", routes };
