import type { LmsModule } from "../core/types";
import { activitiesModule } from "./activities";
import { assignmentModule } from "./assignment";
import { attendanceModule } from "./attendance";
import { authModule } from "./auth";
import { badgesModule } from "./badges";
import { billingModule } from "./billing";
import { calendarModule } from "./calendar";
import { certificateModule } from "./certificate";
import { completionModule } from "./completion";
import { contentModule } from "./content";
import { coursesModule } from "./courses";
import { filesModule } from "./files";
import { forumModule } from "./forum";
import { gradebookModule } from "./gradebook";
import { interactiveModule } from "./interactive";
import { notificationsModule } from "./notifications";
import { organizationModule } from "./organization";
import { paymentsModule } from "./payments";
import { questionBankModule } from "./questionbank";
import { quizModule } from "./quiz";
import { reportsModule } from "./reports";
import { rolesModule } from "./roles";
import { usersModule } from "./users";
import { videoModule } from "./video";
import { workshopModule } from "./workshop";
import { backupModule } from "./backup";
import { ltiModule } from "./lti";
import { messagingModule } from "./messaging";
import { mfaModule } from "./mfa";
import { schedulerModule } from "./scheduler";
import { scormModule } from "./scorm";
import { searchModule } from "./search";
import { ssoModule } from "./sso";

/**
 * Every feature module, in registration order. Adding a module = create
 * `modules/<name>/{index,routes,service,capabilities}.ts` and list it here.
 */
export const modules: LmsModule[] = [
  // core
  authModule,
  mfaModule,
  ssoModule,
  usersModule,
  rolesModule,
  organizationModule,
  filesModule,
  coursesModule,
  activitiesModule,
  // engines
  gradebookModule,
  completionModule,
  notificationsModule,
  calendarModule,
  reportsModule,
  schedulerModule,
  searchModule,
  messagingModule,
  backupModule,
  // activities
  contentModule,
  assignmentModule,
  questionBankModule,
  quizModule,
  forumModule,
  workshopModule,
  attendanceModule,
  interactiveModule,
  videoModule,
  certificateModule,
  badgesModule,
  ltiModule,
  scormModule,
  // commerce
  paymentsModule,
  billingModule,
];
