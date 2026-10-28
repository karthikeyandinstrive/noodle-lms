import { Redis } from "ioredis";
import { config } from "../config";

/** Redis is optional in development; production deployments should set REDIS_URL. */
export const redis = config.REDIS_URL ? new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: false }) : null;

const memory = new Map<string, { value: string; expires: number }>();

/** Small cache helper with an in-memory fallback. */
export const cache = {
  async get(key: string): Promise<string | null> {
    if (redis) return redis.get(key);
    const hit = memory.get(key);
    if (!hit || hit.expires < Date.now()) return null;
    return hit.value;
  },
  async set(key: string, value: string, ttlSeconds: number) {
    if (redis) {
      await redis.set(key, value, "EX", ttlSeconds);
      return;
    }
    memory.set(key, { value, expires: Date.now() + ttlSeconds * 1000 });
  },
  async del(...keys: string[]) {
    if (!keys.length) return;
    if (redis) {
      await redis.del(...keys);
      return;
    }
    for (const k of keys) memory.delete(k);
  },
  /** Bumps a namespace version, invalidating every key built with `versioned()`. */
  async bump(namespace: string) {
    if (redis) {
      await redis.incr(`v:${namespace}`);
      return;
    }
    const cur = Number(memory.get(`v:${namespace}`)?.value ?? 0);
    memory.set(`v:${namespace}`, { value: String(cur + 1), expires: Number.MAX_SAFE_INTEGER });
  },
  async version(namespace: string) {
    return (await this.get(`v:${namespace}`)) ?? "0";
  },
};
