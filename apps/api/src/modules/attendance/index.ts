import type { LmsModule } from "../../core/types";
import { capabilities } from "./capabilities";
import { routes } from "./routes";
import { registerAttendance } from "./service";

export const attendanceModule: LmsModule = {
  name: "attendance",
  basePath: "/attendance",
  routes,
  capabilities,
  setup() {
    registerAttendance();
  },
};
