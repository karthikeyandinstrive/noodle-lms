export type ContextLevel = "system" | "category" | "course" | "activity" | "user";
export type Permission = "allow" | "prevent" | "prohibit";
export type Archetype =
  | "super_admin"
  | "org_admin"
  | "manager"
  | "course_creator"
  | "editing_teacher"
  | "teacher"
  | "student"
  | "guest";

type CapabilityDef = {
  description: string;
  /** Lowest context level at which the capability is meaningful. */
  level: ContextLevel;
  /** Risky capabilities (data exposure, config, money) are flagged in the admin UI. */
  risky?: boolean;
  /** Archetypes granted "allow" by default. super_admin always has everything. */
  defaults: Archetype[];
};

const STAFF: Archetype[] = ["org_admin", "manager"];
const EDITORS: Archetype[] = [...STAFF, "editing_teacher"];
const GRADERS: Archetype[] = [...EDITORS, "teacher"];

/**
 * Single source of truth for every capability in the system.
 * Modules group theirs by prefix (`assignment:*`, `quiz:*` …).
 */
export const CAPABILITIES = {
  // site / organization
  "site:config": { description: "Change organization settings", level: "system", risky: true, defaults: ["org_admin"] },
  "site:view_audit_log": { description: "View audit logs", level: "system", risky: true, defaults: STAFF },
  "storage:manage": { description: "Configure file storage", level: "system", risky: true, defaults: ["org_admin"] },
  "payment:manage": { description: "Configure payment gateways and view orders", level: "system", risky: true, defaults: ["org_admin"] },
  "billing:manage": { description: "Manage the organization's subscription", level: "system", risky: true, defaults: ["org_admin"] },

  // users & roles
  "user:view": { description: "View user profiles", level: "system", defaults: STAFF },
  "user:manage": { description: "Create, edit, suspend users", level: "system", risky: true, defaults: STAFF },
  "role:manage": { description: "Define roles and permissions", level: "system", risky: true, defaults: ["org_admin"] },
  "role:assign": { description: "Assign roles to users", level: "course", risky: true, defaults: EDITORS },
  "cohort:manage": { description: "Manage cohorts", level: "category", defaults: STAFF },

  // categories & courses
  "category:manage": { description: "Manage course categories", level: "category", defaults: STAFF },
  "course:create": { description: "Create courses", level: "category", defaults: [...STAFF, "course_creator"] },
  "course:view": { description: "View course content", level: "course", defaults: [...GRADERS, "student", "guest"] },
  "course:view_hidden": { description: "View hidden courses and activities", level: "course", defaults: GRADERS },
  "course:update": { description: "Edit course settings and content", level: "course", defaults: EDITORS },
  "course:delete": { description: "Delete courses", level: "course", risky: true, defaults: STAFF },
  "course:enrol_manage": { description: "Enrol and unenrol participants", level: "course", defaults: EDITORS },
  "course:view_participants": { description: "View the participant list", level: "course", defaults: [...GRADERS, "student"] },
  "course:manage_groups": { description: "Manage groups", level: "course", defaults: EDITORS },
  "course:self_enrol": { description: "Self-enrol into courses", level: "course", defaults: ["student", "guest"] },

  // activities (generic)
  "activity:create": { description: "Add activities to a course", level: "course", defaults: EDITORS },
  "activity:update": { description: "Edit activities", level: "activity", defaults: EDITORS },
  "activity:delete": { description: "Delete activities", level: "activity", defaults: EDITORS },
  "activity:grade": { description: "Grade any activity", level: "activity", defaults: GRADERS },
  "completion:override": { description: "Override activity completion", level: "course", defaults: GRADERS },

  // assignment
  "assignment:submit": { description: "Submit assignments", level: "activity", defaults: ["student"] },
  "assignment:view_submissions": { description: "View all submissions", level: "activity", defaults: GRADERS },
  "assignment:grade": { description: "Grade submissions", level: "activity", defaults: GRADERS },

  // quiz
  "quiz:attempt": { description: "Attempt quizzes", level: "activity", defaults: ["student"] },
  "quiz:preview": { description: "Preview quizzes", level: "activity", defaults: GRADERS },
  "quiz:view_reports": { description: "View quiz results", level: "activity", defaults: GRADERS },
  "quiz:grade": { description: "Manually grade quiz questions", level: "activity", defaults: GRADERS },
  "question:manage": { description: "Manage the question bank", level: "course", defaults: EDITORS },

  // forum
  "forum:view": { description: "View forum discussions", level: "activity", defaults: [...GRADERS, "student", "guest"] },
  "forum:start_discussion": { description: "Start discussions", level: "activity", defaults: [...GRADERS, "student"] },
  "forum:reply": { description: "Reply to posts", level: "activity", defaults: [...GRADERS, "student"] },
  "forum:moderate": { description: "Pin, lock, edit and delete any post", level: "activity", defaults: GRADERS },
  "forum:post_news": { description: "Post to announcement forums", level: "activity", defaults: GRADERS },

  // workshop
  "workshop:submit": { description: "Submit work for peer assessment", level: "activity", defaults: ["student"] },
  "workshop:peer_assess": { description: "Assess peers' work", level: "activity", defaults: ["student"] },
  "workshop:manage": { description: "Switch phases, allocate reviewers, override grades", level: "activity", defaults: GRADERS },

  // attendance
  "attendance:take": { description: "Take attendance", level: "activity", defaults: GRADERS },
  "attendance:view_all": { description: "View everyone's attendance", level: "activity", defaults: GRADERS },
  "attendance:self_mark": { description: "Mark own attendance", level: "activity", defaults: ["student"] },

  // gradebook
  "grades:view_own": { description: "View own grades", level: "course", defaults: ["student"] },
  "grades:view_all": { description: "View the full gradebook", level: "course", defaults: GRADERS },
  "grades:edit": { description: "Edit grades and gradebook setup", level: "course", defaults: EDITORS },
  "grades:export": { description: "Export grades", level: "course", defaults: GRADERS },

  // certificates & badges
  "certificate:manage_templates": { description: "Manage certificate templates", level: "system", defaults: STAFF },
  "certificate:issue": { description: "Issue certificates manually", level: "activity", defaults: EDITORS },
  "certificate:view_issued": { description: "View all issued certificates", level: "activity", defaults: GRADERS },
  "badge:manage": { description: "Create and edit badges", level: "course", defaults: EDITORS },
  "badge:award": { description: "Award badges manually", level: "course", defaults: GRADERS },

  // interactive / video
  "interactive:view": { description: "Use interactive content", level: "activity", defaults: [...GRADERS, "student"] },
  "interactive:view_results": { description: "View interactive content results", level: "activity", defaults: GRADERS },
  "video:join": { description: "Join video meetings", level: "activity", defaults: [...GRADERS, "student"] },
  "video:moderate": { description: "Moderate video meetings", level: "activity", defaults: GRADERS },

  // reports & calendar & notifications
  "report:view_course": { description: "View course reports", level: "course", defaults: GRADERS },
  "report:view_site": { description: "View site-wide reports", level: "system", defaults: STAFF },
  "calendar:manage_site": { description: "Manage site calendar events", level: "system", defaults: STAFF },
  "calendar:manage_course": { description: "Manage course calendar events", level: "course", defaults: EDITORS },
  "notification:send": { description: "Send notifications to course participants", level: "course", defaults: GRADERS },

  // messaging
  "message:send": { description: "Send private messages to people in your courses", level: "system", defaults: [...GRADERS, "student"] },
  "message:send_any": { description: "Message any user in the organization", level: "system", defaults: STAFF },

  // interoperability
  "lti:manage_tools": { description: "Register external LTI tools", level: "system", risky: true, defaults: ["org_admin"] },
  "lti:manage_course_tools": { description: "Register external LTI tools for one course", level: "course", risky: true, defaults: EDITORS },
  "lti:launch": { description: "Launch external tools", level: "activity", defaults: [...GRADERS, "student"] },
  "scorm:attempt": { description: "Attempt SCORM packages", level: "activity", defaults: ["student"] },
  "scorm:view_reports": { description: "View SCORM attempts of all learners", level: "activity", defaults: GRADERS },

  // backup / restore
  "course:backup": { description: "Back up courses", level: "course", defaults: EDITORS },
  "course:restore": { description: "Restore courses from a backup", level: "category", risky: true, defaults: [...STAFF, "course_creator"] },

  // platform
  "site:manage_sso": { description: "Configure single sign-on", level: "system", risky: true, defaults: ["org_admin"] },
  "site:view_system": { description: "View background jobs and system health", level: "system", defaults: ["org_admin"] },
} as const satisfies Record<string, CapabilityDef>;

export type Capability = keyof typeof CAPABILITIES;

export const CAPABILITY_NAMES = Object.keys(CAPABILITIES) as Capability[];

export function isCapability(value: string): value is Capability {
  return value in CAPABILITIES;
}

export const ARCHETYPES: { archetype: Archetype; name: string; description: string; levels: ContextLevel[] }[] = [
  { archetype: "super_admin", name: "Super admin", description: "Platform owner. Bypasses all checks.", levels: ["system"] },
  { archetype: "org_admin", name: "Organization admin", description: "Full control over one organization.", levels: ["system"] },
  { archetype: "manager", name: "Manager", description: "Manages courses and users.", levels: ["system", "category", "course"] },
  { archetype: "course_creator", name: "Course creator", description: "Can create courses.", levels: ["system", "category"] },
  { archetype: "editing_teacher", name: "Teacher", description: "Edits course content and grades.", levels: ["course", "activity"] },
  { archetype: "teacher", name: "Non-editing teacher", description: "Grades but cannot edit content.", levels: ["course", "activity"] },
  { archetype: "student", name: "Student", description: "Participates in courses.", levels: ["course", "activity"] },
  { archetype: "guest", name: "Guest", description: "Read-only access to open courses.", levels: ["course"] },
];

/** Default allow-list for an archetype. */
export function defaultCapabilities(archetype: Archetype): Capability[] {
  if (archetype === "super_admin") return [...CAPABILITY_NAMES];
  return CAPABILITY_NAMES.filter((c) => (CAPABILITIES[c].defaults as readonly Archetype[]).includes(archetype));
}
