import type { ActivityType } from "@/lib/types";
import { assignmentActivity } from "../assignment";
import { attendanceActivity } from "../attendance";
import { certificateActivity } from "../certificate";
import { fileActivity } from "../file";
import { forumActivity } from "../forum";
import { interactiveActivity } from "../interactive";
import { pageActivity } from "../page";
import { quizActivity } from "../quiz";
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
};

export const activityTypes = Object.values(activityRegistry);
