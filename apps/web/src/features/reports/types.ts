export type Series = { date: string; value: number }[];
type ActivityRef = { id: string; name: string; type: string };

export type CourseOverviewReport = {
  learners: number;
  completions: number;
  views30d: number;
  activeUsersByDay: Series;
  activities: (ActivityRef & { views: number; viewers: number; completed: number })[];
};

export type ParticipationReport = {
  activities: ActivityRef[];
  activityId: string | null;
  items: {
    user: { id: string; firstName: string; lastName: string };
    views: number;
    lastViewedAt: string | null;
    submissions: number;
    lastSubmittedAt: string | null;
    completion: string | null;
  }[];
  total: number;
  page: number;
  pageSize: number;
};

export type OutlineReport = {
  user: { id: string; firstName: string; lastName: string };
  activities: (ActivityRef & { views: number; lastViewedAt: string | null; completion: string | null; grade: number | null; gradeMax: number | null })[];
};

export type LogPage = {
  items: { id: string; eventName: string; createdAt: string; user: { id: string; firstName: string; lastName: string } | null; activity: { id: string; name: string } | null }[];
  total: number;
  page: number;
  pageSize: number;
  eventNames: string[];
};

export type SiteReport = {
  users: number;
  newUsers30d: number;
  activeUsers7d: number;
  activeUsers30d: number;
  courses: number;
  visibleCourses: number;
  enrolments: number;
  completions: number;
  completions30d: number;
  activeUsersByDay: Series;
  topCourses: { id: string; fullname: string; shortname: string; enrolments: number; completions: number }[];
};
