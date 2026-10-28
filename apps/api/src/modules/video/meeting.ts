import { createHash } from "node:crypto";

/** Pure helpers for video meetings (unit-tested; no DB/config imports). */

export const JOIN_GRACE_MINUTES = 15;
export const JITSI_BASE = "https://meet.jit.si";

/**
 * Unguessable Jitsi room name: a digest of org + activity (stable prefix, useful
 * in logs) plus a server-generated random suffix (the actual secret).
 */
export function jitsiRoomName(organizationId: string, activityId: string, randomSuffix: string) {
  if (!/^[A-Za-z0-9]{16,64}$/.test(randomSuffix)) throw new Error("randomSuffix must be 16-64 alphanumeric characters");
  const digest = createHash("sha256").update(`${organizationId}:${activityId}`).digest("hex").slice(0, 12);
  return `lms-${digest}-${randomSuffix}`;
}

/** Jitsi join URL with the display name (and a few UX defaults) passed in the URL hash (never sent to the server). */
export function jitsiJoinUrl(room: string, displayName: string, opts: { moderator?: boolean; subject?: string } = {}) {
  const cfg: Record<string, unknown> = {
    "userInfo.displayName": displayName.slice(0, 100),
    "config.prejoinPageEnabled": true,
    "config.disableDeepLinking": true,
  };
  if (opts.subject) cfg["config.subject"] = opts.subject.slice(0, 200);
  if (!opts.moderator) cfg["config.startWithVideoMuted"] = true;
  const hash = Object.entries(cfg)
    .map(([k, v]) => `${k}=${encodeURIComponent(JSON.stringify(v))}`)
    .join("&");
  return `${JITSI_BASE}/${encodeURIComponent(room)}#${hash}`;
}

/** Whether a learner may join now: from 15 min before start until 15 min after the scheduled end. */
export function joinWindow(startsAt: Date, durationMinutes: number, now = new Date(), graceMinutes = JOIN_GRACE_MINUTES) {
  const opensAt = new Date(startsAt.getTime() - graceMinutes * 60_000);
  const closesAt = new Date(startsAt.getTime() + (durationMinutes + graceMinutes) * 60_000);
  return { opensAt, closesAt, open: now >= opensAt && now <= closesAt };
}

/** https-only external meeting/recording URLs (never fetched server-side). */
export function httpsUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw || raw.length > 2000) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password || !u.hostname) return null;
    return u.href;
  } catch {
    return null;
  }
}
