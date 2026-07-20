import { initialBucket, retryAfterMs, takeToken, type TokenBucketState } from "@dispatch/domain";
import type { Redis } from "ioredis";

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs: number;
}

/**
 * Per-relay (and per-workspace) send rate limiter. Implementations must be
 * atomic across worker processes; the Redis implementation uses a Lua script.
 */
export interface RateLimiter {
  take(key: string, config: { ratePerSecond: number; burst: number }): Promise<RateLimitResult>;
}

const TAKE_TOKEN_LUA = `
local key = KEYS[1]
local rate = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local now_ms = tonumber(ARGV[3])
local data = redis.call("HMGET", key, "tokens", "updated_at_ms")
local tokens = tonumber(data[1]) or burst
local updated = tonumber(data[2]) or now_ms
local elapsed = math.max(0, now_ms - updated)
local refilled = math.min(burst, tokens + (elapsed / 1000) * rate)
if refilled < 1 then
  redis.call("HMSET", key, "tokens", refilled, "updated_at_ms", now_ms)
  redis.call("PEXPIRE", key, 60000)
  return {0, math.ceil(((1 - refilled) / rate) * 1000)}
end
redis.call("HMSET", key, "tokens", refilled - 1, "updated_at_ms", now_ms)
redis.call("PEXPIRE", key, 60000)
return {1, 0}
`;

/** Atomic Redis-backed token bucket for multi-process workers. */
export function createRedisRateLimiter(redis: Redis): RateLimiter {
  return {
    async take(key, config) {
      const result = (await redis.eval(
        TAKE_TOKEN_LUA,
        1,
        `ratelimit:${key}`,
        String(config.ratePerSecond),
        String(config.burst),
        String(Date.now()),
      )) as [number, number];
      const [allowed, retryAfter] = result;
      return { allowed: allowed === 1, retryAfterMs: retryAfter ?? 0 };
    },
  };
}

/** In-process limiter for tests and single-process runs. */
export function createMemoryRateLimiter(now: () => number = Date.now): RateLimiter {
  const buckets = new Map<string, TokenBucketState>();
  return {
    take(key, config) {
      const state = buckets.get(key) ?? initialBucket(config);
      const result = takeToken(state, config, now());
      buckets.set(key, result.state);
      return Promise.resolve({
        allowed: result.allowed,
        retryAfterMs: retryAfterMs(result.state, config),
      });
    },
  };
}
