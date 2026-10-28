import { EventEmitter } from "node:events";
import type { Redis } from "ioredis";
import { logger } from "./logger";
import { redis } from "./redis";

/**
 * Per-user live updates for open browser tabs (server-sent events). With one API process
 * an in-memory emitter is enough; with Redis every replica subscribes to one channel, so a
 * message sent through one replica reaches tabs connected to another.
 *
 * Events are hints ("something changed, refetch"), never data: clients re-read through the
 * normal permission-checked API, so a missed or duplicated event is harmless.
 */
export type LiveEvent = { type: "message"; conversationId: string } | { type: "notification" };

const CHANNEL = "lms:live";
const local = new EventEmitter();
local.setMaxListeners(0);

let subscriber: Redis | null = null;
function ensureSubscriber() {
  if (!redis || subscriber) return;
  subscriber = redis.duplicate();
  subscriber.subscribe(CHANNEL).catch((err: unknown) => logger.error({ err }, "live: redis subscribe failed"));
  subscriber.on("message", (_channel: string, raw: string) => {
    try {
      const { u, e } = JSON.parse(raw) as { u: string[]; e: LiveEvent };
      for (const userId of u) local.emit(userId, e);
    } catch (err) {
      logger.warn({ err }, "live: bad message");
    }
  });
}

/** Tells these users' open tabs that something changed. Call after the change committed. */
export async function publishLive(userIds: string[], event: LiveEvent) {
  const u = [...new Set(userIds)];
  if (!u.length) return;
  if (redis) {
    await redis.publish(CHANNEL, JSON.stringify({ u, e: event })).catch((err: unknown) => logger.warn({ err }, "live: publish failed"));
    return;
  }
  for (const userId of u) local.emit(userId, event);
}

/** Listens for a user's live events; returns the unsubscribe function. */
export function subscribeLive(userId: string, fn: (event: LiveEvent) => void) {
  ensureSubscriber();
  local.on(userId, fn);
  return () => {
    local.off(userId, fn);
  };
}

export const liveListenerCount = (userId: string) => local.listenerCount(userId);
