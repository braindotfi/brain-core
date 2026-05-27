/**
 * Redis sorted-set sliding-window rate limiter (P0.3).
 *
 * Each event is a member of a per-key ZSET scored by its epoch-ms timestamp.
 * On each hit we ZADD the event, ZREMRANGEBYSCORE everything older than the
 * window, ZCARD the survivors, and PEXPIRE the key so idle keys self-evict.
 * `allowed` is `count <= limit` — so with limit=60 the 61st hit inside the
 * window is denied. The denied hit still counts (ZADD-first, per spec), which
 * means the limit is on *attempts per window*, the desired behavior for abuse
 * control.
 *
 * A matching in-memory double mirrors the semantics for hermetic tests.
 */

import type { Redis } from "ioredis";

export interface RateLimitDecision {
  /** True when this hit is within the limit. */
  allowed: boolean;
  /** Number of events in the current window, including this hit. */
  count: number;
  /** The configured per-window limit. */
  limit: number;
}

export interface SlidingWindowOptions {
  /** Window length in seconds (e.g. 3600 for one hour). */
  windowSeconds: number;
  /** Max events allowed per window. */
  limit: number;
  /** Injectable clock (epoch ms). Defaults to Date.now. For tests. */
  now?: () => number;
}

export interface SlidingWindowRateLimiter {
  /** Record a hit on `key` and decide whether it is within the limit. */
  hit(key: string): Promise<RateLimitDecision>;
}

let memberSeq = 0;

/** Redis-backed sliding-window limiter. */
export class RedisSlidingWindowRateLimiter implements SlidingWindowRateLimiter {
  public constructor(
    private readonly redis: Redis,
    private readonly opts: SlidingWindowOptions,
  ) {}

  public async hit(key: string): Promise<RateLimitDecision> {
    const now = (this.opts.now ?? Date.now)();
    const windowMs = this.opts.windowSeconds * 1000;
    const cutoff = now - windowMs;
    // Unique member per hit (concurrent hits in the same ms must not collide).
    memberSeq = (memberSeq + 1) % Number.MAX_SAFE_INTEGER;
    const member = `${now}-${memberSeq}`;

    const res = await this.redis
      .multi()
      .zadd(key, now, member)
      .zremrangebyscore(key, 0, cutoff)
      .zcard(key)
      .pexpire(key, windowMs)
      .exec();

    // exec() → [err, result][] | null. ZCARD is the third command (index 2).
    const raw = res?.[2];
    const count = raw !== undefined && raw[0] === null && typeof raw[1] === "number" ? raw[1] : 0;

    // Fail-open: if the count is unreadable (Redis blip / aborted txn) we allow
    // rather than block all annotations on a soft limiter. count=0 signals this.
    if (count === 0) {
      return { allowed: true, count: 0, limit: this.opts.limit };
    }
    return { allowed: count <= this.opts.limit, count, limit: this.opts.limit };
  }
}

/** In-memory double for hermetic tests — same semantics as the Redis impl. */
export class InMemorySlidingWindowRateLimiter implements SlidingWindowRateLimiter {
  private readonly buckets = new Map<string, number[]>();

  public constructor(private readonly opts: SlidingWindowOptions) {}

  public async hit(key: string): Promise<RateLimitDecision> {
    const now = (this.opts.now ?? Date.now)();
    const cutoff = now - this.opts.windowSeconds * 1000;
    const kept = (this.buckets.get(key) ?? []).filter((ts) => ts > cutoff);
    kept.push(now);
    this.buckets.set(key, kept);
    return { allowed: kept.length <= this.opts.limit, count: kept.length, limit: this.opts.limit };
  }
}
