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

export interface ApiRateLimitPolicy {
  /** Immutable tier revision that supplied this policy. */
  tierId: string;
  /** Tenant entitlement revision copied into request-meter evidence. */
  entitlementVersion: number;
  /** Sliding-window length in seconds. */
  windowSeconds: number;
  /** Effective limit for this key after any restrictive override. */
  keyLimit: number;
  /** Aggregate limit shared by every key in the tenant and environment. */
  tenantLimit: number;
}

export interface ApiRateLimitDecision extends RateLimitDecision {
  /** Tenant-wide count for the same atomic decision. */
  tenantCount: number;
  /** Tenant-wide limit for the same atomic decision. */
  tenantLimit: number;
  /** Which bucket rejected the request, or null when allowed. */
  rejectedBy: "key" | "tenant" | "key_and_tenant" | null;
  /** Immutable server-owned policy context. */
  policy: ApiRateLimitPolicy;
}

export interface ApiSlidingWindowHit {
  keyBucket: string;
  tenantBucket: string;
  /** Globally unique gateway request id. */
  requestId: string;
  policy: ApiRateLimitPolicy;
}

export interface ApiSlidingWindowRateLimiter {
  hit(input: ApiSlidingWindowHit): Promise<ApiRateLimitDecision>;
}

/**
 * One atomic Redis decision for both commercial entitlement buckets.
 * Rejected attempts are observed in the returned counts but are not appended,
 * so one hot key cannot consume the shared tenant allowance by retrying 429s.
 */
const API_DUAL_SLIDING_WINDOW_LUA = `
local key_bucket = KEYS[1]
local tenant_bucket = KEYS[2]
local now = tonumber(ARGV[1])
local cutoff = tonumber(ARGV[2])
local window_ms = tonumber(ARGV[3])
local key_limit = tonumber(ARGV[4])
local tenant_limit = tonumber(ARGV[5])
local member = ARGV[6]

redis.call('ZREMRANGEBYSCORE', key_bucket, 0, cutoff)
redis.call('ZREMRANGEBYSCORE', tenant_bucket, 0, cutoff)

local key_count = redis.call('ZCARD', key_bucket)
local tenant_count = redis.call('ZCARD', tenant_bucket)
local key_seen = redis.call('ZSCORE', key_bucket, member)
local tenant_seen = redis.call('ZSCORE', tenant_bucket, member)

if key_seen and tenant_seen then
  return { 1, key_count, tenant_count }
end

local next_key_count = key_count + 1
local next_tenant_count = tenant_count + 1
local allowed = 0

if next_key_count <= key_limit and next_tenant_count <= tenant_limit then
  redis.call('ZADD', key_bucket, 'NX', now, member)
  redis.call('ZADD', tenant_bucket, 'NX', now, member)
  redis.call('PEXPIRE', key_bucket, window_ms)
  redis.call('PEXPIRE', tenant_bucket, window_ms)
  key_count = redis.call('ZCARD', key_bucket)
  tenant_count = redis.call('ZCARD', tenant_bucket)
  allowed = 1
else
  key_count = next_key_count
  tenant_count = next_tenant_count
end

return { allowed, key_count, tenant_count }
`;

export class RedisApiSlidingWindowRateLimiter implements ApiSlidingWindowRateLimiter {
  public constructor(
    private readonly redis: Redis,
    private readonly now: () => number = Date.now,
    private readonly timeoutMs = 2_000,
  ) {}

  public async hit(input: ApiSlidingWindowHit): Promise<ApiRateLimitDecision> {
    const now = this.now();
    const windowMs = input.policy.windowSeconds * 1000;
    const result = await withTimeout(
      this.redis.eval(
        API_DUAL_SLIDING_WINDOW_LUA,
        2,
        input.keyBucket,
        input.tenantBucket,
        now,
        now - windowMs,
        windowMs,
        input.policy.keyLimit,
        input.policy.tenantLimit,
        input.requestId,
      ),
      this.timeoutMs,
    );
    if (!Array.isArray(result) || result.length !== 3) {
      throw new Error("Redis returned an invalid API rate-limit decision");
    }
    const allowedValue = Number(result[0]);
    const keyCount = Number(result[1]);
    const tenantCount = Number(result[2]);
    if (
      (allowedValue !== 0 && allowedValue !== 1) ||
      !Number.isSafeInteger(keyCount) ||
      keyCount < 0 ||
      !Number.isSafeInteger(tenantCount) ||
      tenantCount < 0
    ) {
      throw new Error("Redis returned malformed API rate-limit counters");
    }
    const keyRejected = keyCount > input.policy.keyLimit;
    const tenantRejected = tenantCount > input.policy.tenantLimit;
    return {
      allowed: allowedValue === 1,
      count: keyCount,
      limit: input.policy.keyLimit,
      tenantCount,
      tenantLimit: input.policy.tenantLimit,
      rejectedBy:
        keyRejected && tenantRejected
          ? "key_and_tenant"
          : keyRejected
            ? "key"
            : tenantRejected
              ? "tenant"
              : null,
      policy: input.policy,
    };
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Redis API rate-limit decision timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/** Hermetic double with the same combined-bucket semantics. */
export class InMemoryApiSlidingWindowRateLimiter implements ApiSlidingWindowRateLimiter {
  private readonly buckets = new Map<string, Map<string, number>>();

  public constructor(private readonly now: () => number = Date.now) {}

  public async hit(input: ApiSlidingWindowHit): Promise<ApiRateLimitDecision> {
    const now = this.now();
    const cutoff = now - input.policy.windowSeconds * 1000;
    const keyEvents = this.activeEvents(input.keyBucket, cutoff);
    const tenantEvents = this.activeEvents(input.tenantBucket, cutoff);
    const alreadyRecorded = keyEvents.has(input.requestId) && tenantEvents.has(input.requestId);
    const keyCount = keyEvents.size + (alreadyRecorded ? 0 : 1);
    const tenantCount = tenantEvents.size + (alreadyRecorded ? 0 : 1);
    const keyRejected = keyCount > input.policy.keyLimit;
    const tenantRejected = tenantCount > input.policy.tenantLimit;
    const allowed = !keyRejected && !tenantRejected;
    if (allowed && !alreadyRecorded) {
      keyEvents.set(input.requestId, now);
      tenantEvents.set(input.requestId, now);
    }
    return {
      allowed,
      count: keyCount,
      limit: input.policy.keyLimit,
      tenantCount,
      tenantLimit: input.policy.tenantLimit,
      rejectedBy:
        keyRejected && tenantRejected
          ? "key_and_tenant"
          : keyRejected
            ? "key"
            : tenantRejected
              ? "tenant"
              : null,
      policy: input.policy,
    };
  }

  private activeEvents(bucket: string, cutoff: number): Map<string, number> {
    const events = this.buckets.get(bucket) ?? new Map<string, number>();
    for (const [member, timestamp] of events) {
      if (timestamp <= cutoff) events.delete(member);
    }
    this.buckets.set(bucket, events);
    return events;
  }
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
