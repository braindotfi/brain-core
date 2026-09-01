import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RedisIdempotencyStore, hashBody, idempotencyRedisKey } from "./idempotency/store.js";
import {
  RedisApiSlidingWindowRateLimiter,
  RedisSlidingWindowRateLimiter,
} from "./ratelimit/sliding-window.js";

const runRedisIntegration = process.env.REDIS_INTEGRATION_TESTS === "true";
const redisUrl = process.env.REDIS_URL;
const keyPrefix = `ci:ioredis-v6:${randomUUID()}`;
const usedKeys = new Set<string>();
let redis: Redis;

function key(name: string): string {
  const value = `${keyPrefix}:${name}`;
  usedKeys.add(value);
  return value;
}

describe.runIf(runRedisIntegration)("ioredis v6 integration", () => {
  beforeAll(async () => {
    if (redisUrl === undefined || redisUrl.length === 0) {
      throw new Error("REDIS_INTEGRATION_TESTS requires REDIS_URL");
    }
    // Keep the same default client-info behavior as the production API client.
    redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: null });
    await redis.connect();
    await redis.ping();
  });

  afterAll(async () => {
    if (redis !== undefined) {
      if (usedKeys.size > 0) await redis.del(...usedKeys);
      await redis.quit();
    }
  });

  it("replays a completed idempotent response through Redis", async () => {
    const store = new RedisIdempotencyStore(redis);
    const tenantId = `tnt_ci_${randomUUID().replaceAll("-", "")}`;
    const idempotencyKey = key("idempotency");
    const input = {
      tenantId,
      key: idempotencyKey,
      bodyHash: hashBody('{"amount":19400}'),
      ttlSeconds: 60,
    };
    usedKeys.add(idempotencyRedisKey(tenantId, idempotencyKey));

    expect(await store.probeAndMark(input)).toEqual({ state: "miss" });
    await store.complete({
      ...input,
      response: { status: 201, body: '{"payment_intent_id":"pi_ci"}' },
    });

    const replay = await store.probeAndMark(input);
    expect(replay).toEqual({
      state: "done",
      bodyHash: input.bodyHash,
      response: { status: 201, body: '{"payment_intent_id":"pi_ci"}' },
    });
  });

  it("enforces a sliding-window limit through an actual Redis MULTI transaction", async () => {
    const rateLimitKey = key("rate-limit");
    const limiter = new RedisSlidingWindowRateLimiter(redis, {
      windowSeconds: 60,
      limit: 2,
    });

    expect(await limiter.hit(rateLimitKey)).toMatchObject({ allowed: true, count: 1, limit: 2 });
    expect(await limiter.hit(rateLimitKey)).toMatchObject({ allowed: true, count: 2, limit: 2 });
    expect(await limiter.hit(rateLimitKey)).toMatchObject({ allowed: false, count: 3, limit: 2 });
    expect(await redis.pttl(rateLimitKey)).toBeGreaterThan(0);
  });

  it("atomically enforces API key and tenant sliding windows", async () => {
    const limiter = new RedisApiSlidingWindowRateLimiter(redis);
    const policy = {
      tierId: "starter_v1",
      entitlementVersion: 1,
      windowSeconds: 60,
      keyLimit: 1,
      tenantLimit: 2,
    };
    const tenantBucket = key("api-rate-tenant");
    const hit = (keyBucket: string, requestId: string) =>
      limiter.hit({ keyBucket, tenantBucket, requestId, policy });

    expect(await hit(key("api-rate-key-1"), "req_1")).toMatchObject({
      allowed: true,
      count: 1,
      tenantCount: 1,
    });
    expect(await hit(key("api-rate-key-1"), "req_2")).toMatchObject({
      allowed: false,
      rejectedBy: "key",
    });
    expect(await hit(key("api-rate-key-2"), "req_3")).toMatchObject({
      allowed: true,
      tenantCount: 2,
    });
    expect(await hit(key("api-rate-key-3"), "req_4")).toMatchObject({
      allowed: false,
      rejectedBy: "tenant",
    });
  });
});
