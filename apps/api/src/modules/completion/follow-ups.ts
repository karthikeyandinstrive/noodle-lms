import type { DB } from "@lms/db";
import { emit, on, type EventMap, type EventName } from "../../core/events";
import { logger } from "../../core/logger";

/**
 * Follow-up events raised by event subscribers.
 *
 * Subscribers run inside `withTenant` (core/events). Calling `emit` from inside one would open a
 * second tenant transaction while the first is still open — that nests transactions (and deadlocks
 * the single-connection embedded dev DB). It would also let downstream subscribers (certificates,
 * badges…) read data the handler has not committed yet.
 *
 * So a worker subscriber only *collects* follow-ups (keyed by the payload object, which `emit` passes
 * to every subscriber of the same event) and a second "flush" subscriber, registered right after it,
 * schedules them. Because `emit` runs subscribers one after another and each in its own transaction,
 * the flush runs after the worker's transaction has committed. The flush still runs inside a (no-op)
 * transaction, so it defers the actual emits with `setImmediate` — outside any transaction.
 */
export type FollowUp = { [K in EventName]: { name: K; payload: EventMap[K] } }[EventName];

const pending = new WeakMap<object, FollowUp[]>();

export function subscribeWithFollowUps<K extends EventName>(name: K, worker: (tx: DB, payload: EventMap[K]) => Promise<FollowUp[]>) {
  on(name, async (tx, payload) => {
    const followUps = await worker(tx, payload);
    if (followUps.length) pending.set(payload, followUps);
  });
  on(name, async (_tx, payload) => {
    const followUps = pending.get(payload);
    if (!followUps) return;
    pending.delete(payload);
    setImmediate(() => void emitAll(followUps));
  });
}

/** Emits follow-ups in order (call only outside a transaction). Failures are logged, never thrown. */
export async function emitAll(followUps: FollowUp[]) {
  for (const f of followUps) {
    try {
      await emit(f.name, f.payload as never);
    } catch (err) {
      logger.error({ err, event: f.name }, "follow-up event failed");
    }
  }
}
