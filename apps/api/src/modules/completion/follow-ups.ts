import type { DB } from "@lms/db";
import { emitInTx, type EventMap, type EventName } from "../../core/events";

/**
 * Follow-up events raised by completion changes (`activity.completed`, `course.completed`).
 *
 * They are written to the transactional outbox in the same transaction as the completion change
 * (`emitInTx`), so they are dispatched by the worker only if that change commits — whether the change
 * came from a route or from an event subscriber.
 */
export type FollowUp = { [K in EventName]: { name: K; payload: EventMap[K] } }[EventName];

/** Stores follow-ups in the outbox, in order, inside the caller's transaction. */
export async function emitFollowUps(tx: DB, followUps: FollowUp[]) {
  for (const f of followUps) await emitInTx(tx, f.name, f.payload as never);
}
