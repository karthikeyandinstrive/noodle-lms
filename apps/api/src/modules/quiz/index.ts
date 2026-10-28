import type { LmsModule } from "../../core/types";
import { capabilities } from "./capabilities";
import { routes } from "./routes";
import { registerQuizType } from "./service";

export const quizModule: LmsModule = {
  name: "quiz",
  basePath: "/quizzes",
  routes,
  capabilities,
  setup() {
    registerQuizType();
  },
};
