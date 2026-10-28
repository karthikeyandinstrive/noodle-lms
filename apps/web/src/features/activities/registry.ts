import type { Translate } from "@/lib/i18n";
import type { ActivityType } from "@/lib/types";
import { assignmentActivity } from "../assignment";
import { attendanceActivity } from "../attendance";
import { certificateActivity } from "../certificate";
import { fileActivity } from "../file";
import { forumActivity } from "../forum";
import { interactiveActivity } from "../interactive";
import { ltiActivity } from "../lti";
import { pageActivity } from "../page";
import { quizActivity } from "../quiz";
import { scormActivity } from "../scorm";
import { urlActivity } from "../url";
import { videoActivity } from "../video";
import { workshopActivity } from "../workshop";
import type { ActivityTypeUI } from "./types";

export const activityRegistry: Record<ActivityType, ActivityTypeUI> = {
  page: pageActivity,
  url: urlActivity,
  file: fileActivity,
  assignment: assignmentActivity,
  quiz: quizActivity,
  forum: forumActivity,
  workshop: workshopActivity,
  attendance: attendanceActivity,
  interactive: interactiveActivity,
  video: videoActivity,
  certificate: certificateActivity,
  lti: ltiActivity,
  scorm: scormActivity,
};

export const activityTypes = Object.values(activityRegistry);

/** Translated activity type name (the registry's `label` stays English for non-translated callers). */
export function activityTypeLabel(t: Translate, type: ActivityType) {
  return t(`activity.type.${type}`, activityRegistry[type].label);
}

/** Translated one-line description of an activity type. */
export function activityTypeDescription(t: Translate, type: ActivityType) {
  return t(`activity.typeDescription.${type}`, activityRegistry[type].description);
}
