import type { LmsModule } from "../../core/types";
import { capabilities } from "./capabilities";
import { routes } from "./routes";

export const questionBankModule: LmsModule = {
  name: "questionbank",
  basePath: "/question-bank",
  routes,
  capabilities,
};
