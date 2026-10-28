/**
 * Builds the initial CMI handed to the browser runtime for a session (pure).
 */
import { exitKey, formatTotalTime, isWritable, parseSessionTime, sessionTimeKey, WRITE_ONLY, type Cmi } from "./cmi";
import type { ManifestInfo, ScormVersion } from "./manifest";

export type SessionMode = "normal" | "browse" | "review";

/** Folds a pending session_time into the total (sessions that ended without LMSFinish/Terminate). */
export function foldSessionTime(version: ScormVersion, cmi: Cmi, totalSeconds: number): { cmi: Cmi; totalSeconds: number } {
  const key = sessionTimeKey(version);
  if (!(key in cmi)) return { cmi, totalSeconds };
  const add = parseSessionTime(version, cmi[key]!) ?? 0;
  const { [key]: _drop, ...rest } = cmi;
  return { cmi: rest, totalSeconds: totalSeconds + Math.min(add, 24 * 3600) };
}

/** cmi.entry for a new session: ab-initio on a fresh attempt, resume after a suspend, else "". */
export function entryFor(version: ScormVersion, cmi: Cmi, fresh: boolean) {
  if (fresh) return "ab-initio";
  const exit = cmi[exitKey(version)];
  return exit === "suspend" || (version === "2004" && exit === "logout") ? "resume" : "";
}

export function initialCmi(input: {
  version: ScormVersion;
  stored: Cmi;
  totalSeconds: number;
  entry: string;
  mode: SessionMode;
  user: { id: string; firstName: string; lastName: string };
  manifest: Partial<ManifestInfo>;
}): Cmi {
  const { version, stored, mode, manifest: m } = input;
  const credit = mode === "normal" ? "credit" : "no-credit";
  // Only stored values the SCO may read back (no write-only elements such as exit / session_time).
  const readable: Cmi = {};
  for (const [k, v] of Object.entries(stored)) {
    if (!isWritable(version, k)) continue;
    if (WRITE_ONLY[version].some((re) => re.test(k))) continue;
    readable[k] = v;
  }
  if (version === "1.2") {
    return {
      "cmi.core.lesson_location": "",
      "cmi.core.lesson_status": "not attempted",
      "cmi.core.score.raw": "",
      "cmi.core.score.max": "",
      "cmi.core.score.min": "",
      "cmi.suspend_data": "",
      "cmi.comments": "",
      "cmi.student_preference.audio": "0",
      "cmi.student_preference.language": "",
      "cmi.student_preference.speed": "0",
      "cmi.student_preference.text": "0",
      ...readable,
      "cmi.core.student_id": input.user.id,
      "cmi.core.student_name": `${input.user.lastName}, ${input.user.firstName}`,
      "cmi.core.credit": credit,
      "cmi.core.entry": input.entry,
      "cmi.core.total_time": formatTotalTime(version, input.totalSeconds),
      "cmi.core.lesson_mode": mode,
      "cmi.launch_data": m.launchData ?? "",
      "cmi.comments_from_lms": "",
      "cmi.student_data.mastery_score": m.masteryScore != null ? String(m.masteryScore) : "",
      "cmi.student_data.max_time_allowed": m.maxTimeAllowed ?? "",
      "cmi.student_data.time_limit_action": m.timeLimitAction ?? "",
    };
  }
  return {
    "cmi.location": "",
    "cmi.completion_status": "unknown",
    "cmi.success_status": "unknown",
    "cmi.suspend_data": "",
    "cmi.learner_preference.audio_level": "1",
    "cmi.learner_preference.language": "",
    "cmi.learner_preference.delivery_speed": "1",
    "cmi.learner_preference.audio_captioning": "0",
    ...readable,
    "cmi._version": "1.0",
    "cmi.learner_id": input.user.id,
    "cmi.learner_name": `${input.user.firstName} ${input.user.lastName}`.trim(),
    "cmi.credit": credit,
    "cmi.mode": mode,
    "cmi.entry": input.entry,
    "cmi.total_time": formatTotalTime(version, input.totalSeconds),
    "cmi.launch_data": m.launchData ?? "",
    "cmi.scaled_passing_score": m.scaledPassingScore != null ? String(m.scaledPassingScore) : "",
    "cmi.completion_threshold": m.completionThreshold != null ? String(m.completionThreshold) : "",
    "cmi.max_time_allowed": m.maxTimeAllowed ?? "",
    "cmi.time_limit_action": m.timeLimitAction ?? "continue,no message",
  };
}
