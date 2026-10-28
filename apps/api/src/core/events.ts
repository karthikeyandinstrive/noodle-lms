import { eventLog, withTenant, type DB } from "@lms/db";
import { logger } from "./logger";

type Base = { organizationId: string; userId?: string | null; courseId?: string | null; activityId?: string | null };

/**
 * Every domain event in the system (Moodle "events API").
 * Modules emit these; other modules subscribe instead of importing each other.
 */
export type EventMap = {
  "user.created": Base & { userId: string };
  "user.enrolled": Base & { userId: string; courseId: string };
  "user.unenrolled": Base & { userId: string; courseId: string };
  "course.created": Base & { courseId: string };
  "course.completed": Base & { userId: string; courseId: string };

  "activity.created": Base & { activityId: string; courseId: string; type: string };
  "activity.updated": Base & { activityId: string; courseId: string; type: string };
  "activity.deleted": Base & { activityId: string; courseId: string; type: string };
  "activity.viewed": Base & { activityId: string; courseId: string; userId: string };
  /** Fired when a learner fulfils an activity's "submit" completion rule. */
  "activity.submitted": Base & { activityId: string; courseId: string; userId: string };
  "activity.completed": Base & { activityId: string; courseId: string; userId: string; state: string };

  "assignment.submitted": Base & { activityId: string; courseId: string; userId: string; submissionId: string };
  "assignment.graded": Base & { activityId: string; courseId: string; userId: string; submissionId: string };
  "quiz.attempt_started": Base & { activityId: string; courseId: string; userId: string; attemptId: string };
  "quiz.attempt_submitted": Base & { activityId: string; courseId: string; userId: string; attemptId: string };
  "forum.discussion_created": Base & { activityId: string; courseId: string; userId: string; discussionId: string };
  "forum.post_created": Base & {
    activityId: string;
    courseId: string;
    userId: string;
    discussionId: string;
    postId: string;
  };
  "workshop.phase_changed": Base & { activityId: string; courseId: string; phase: string };
  "attendance.taken": Base & { activityId: string; courseId: string; sessionId: string };
  "interactive.result": Base & { activityId: string; courseId: string; userId: string };
  "video.joined": Base & { activityId: string; courseId: string; userId: string };

  /** Emitted by the gradebook whenever a learner's grade for an item changes. */
  "grade.updated": Base & {
    courseId: string;
    userId: string;
    itemId: string;
    activityId: string | null;
    finalGrade: number | null;
    gradeMax: number;
    gradePass: number | null;
  };
  "certificate.issued": Base & { courseId: string; userId: string; issuedCertificateId: string };
  "badge.awarded": Base & { badgeId: string; userId: string };
  "payment.succeeded": Base & { orderId: string; courseId: string; userId: string };
};

export type EventName = keyof EventMap;
type Handler<K extends EventName> = (tx: DB, payload: EventMap[K]) => Promise<void>;

const handlers = new Map<EventName, Handler<EventName>[]>();

/** Registers a subscriber. Each handler runs in its own tenant transaction. */
export function on<K extends EventName>(name: K, handler: Handler<K>) {
  const list = handlers.get(name) ?? [];
  list.push(handler as unknown as Handler<EventName>);
  handlers.set(name, list);
}

/**
 * Logs the event and runs its subscribers. Call AFTER the originating
 * transaction has committed (never inside `req.tenant(...)`).
 * Subscriber failures are logged and do not fail the caller.
 */
export async function emit<K extends EventName>(name: K, payload: EventMap[K]) {
  await withTenant(payload.organizationId, async (tx) => {
    await tx.insert(eventLog).values({
      organizationId: payload.organizationId,
      eventName: name,
      userId: payload.userId ?? null,
      courseId: payload.courseId ?? null,
      activityId: payload.activityId ?? null,
      data: payload as Record<string, unknown>,
    });
  });
  for (const handler of handlers.get(name) ?? []) {
    try {
      await withTenant(payload.organizationId, (tx) => handler(tx, payload));
    } catch (err) {
      logger.error({ err, event: name }, "event subscriber failed");
    }
  }
}
