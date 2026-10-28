import type { ActivityDetail, ActivityType } from "@/lib/types";

export type ActivityViewProps = {
  activity: ActivityDetail;
  /** Re-fetch the activity (e.g. after a submission changes completion). */
  refresh: () => void;
};

export type SettingsFieldsProps = {
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
  mode: "create" | "edit";
  courseId: string;
  /** Set when editing an existing activity. */
  activityId?: string;
};

/**
 * UI plug-in for an activity type. Each module in `src/features/<type>/`
 * exports one; the registry wires them into the course page, activity page
 * and the add/edit activity form.
 */
export type ActivityTypeUI = {
  type: ActivityType;
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Initial `settings` for a new activity (must satisfy the API's settings schema). */
  defaults: Record<string, unknown>;
  /** Default completion rule suggested for this type. */
  defaultCompletion?: "none" | "manual" | "view" | "submit" | "grade" | "pass";
  View: React.ComponentType<ActivityViewProps>;
  SettingsFields: React.ComponentType<SettingsFieldsProps>;
};
