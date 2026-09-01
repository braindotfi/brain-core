import { describe, expect, it } from "vitest";
import {
  InMemoryApiSlidingWindowRateLimiter,
  RedisApiSlidingWindowRateLimiter,
} from "./sliding-window.js";

const policy = {
  tierId: "starter_v1",
  entitlementVersion: 3,
  windowSeconds: 60,
  keyLimit: 2,
  tenantLimit: 3,
} as const;

describe("InMemoryApiSlidingWindowRateLimiter", () => {
  it("enforces key and tenant buckets with one decision", async () => {
    const limiter = new InMemoryApiSlidingWindowRateLimiter(() => 1_000);
    const hit = (keyId: string, requestId: string) =>
      limiter.hit({
        keyBucket: `api-rate:key:${keyId}`,
        tenantBucket: "api-rate:tenant:tnt_1:sandbox",
        requestId,
        policy,
      });

    expect(await hit("key_1", "req_1")).toMatchObject({
      allowed: true,
      count: 1,
      tenantCount: 1,
      rejectedBy: null,
    });
    expect(await hit("key_1", "req_2")).toMatchObject({
      allowed: true,
      count: 2,
      tenantCount: 2,
    });
    expect(await hit("key_1", "req_3")).toMatchObject({
      allowed: false,
      count: 3,
      tenantCount: 3,
      rejectedBy: "key",
    });
    expect(await hit("key_2", "req_4")).toMatchObject({
      allowed: true,
      count: 1,
      tenantCount: 3,
    });
    expect(await hit("key_2", "req_5")).toMatchObject({
      allowed: false,
      count: 2,
      tenantCount: 4,
      rejectedBy: "tenant",
    });
  });

  it("is idempotent for the same globally unique request id", async () => {
    const limiter = new InMemoryApiSlidingWindowRateLimiter(() => 1_000);
    const input = {
      keyBucket: "api-rate:key:key_1",
      tenantBucket: "api-rate:tenant:tnt_1:sandbox",
      requestId: "req_same",
      policy,
    } as const;

    expect(await limiter.hit(input)).toMatchObject({ count: 1, tenantCount: 1 });
    expect(await limiter.hit(input)).toMatchObject({ count: 1, tenantCount: 1 });
  });

  it("does not let rejected key retries consume tenant capacity", async () => {
    const limiter = new InMemoryApiSlidingWindowRateLimiter(() => 1_000);
    const restrictedPolicy = { ...policy, keyLimit: 1, tenantLimit: 3 };
    const hit = (requestId: string) =>
      limiter.hit({
        keyBucket: "api-rate:key:key_1",
        tenantBucket: "api-rate:tenant:tnt_1:sandbox",
        requestId,
        policy: restrictedPolicy,
      });

    expect((await hit("req_1")).allowed).toBe(true);
    expect(await hit("req_2")).toMatchObject({ allowed: false, tenantCount: 2 });
    expect(await hit("req_3")).toMatchObject({ allowed: false, tenantCount: 2 });
  });

  it("times out instead of silently allowing an unavailable Redis decision", async () => {
    const redis = {
      eval: async () => new Promise<never>(() => undefined),
    };
    const limiter = new RedisApiSlidingWindowRateLimiter(redis as never, () => 1_000, 1);

    await expect(
      limiter.hit({
        keyBucket: "api-rate:key:key_1",
        tenantBucket: "api-rate:tenant:tnt_1:sandbox",
        requestId: "req_timeout",
        policy,
      }),
    ).rejects.toThrow("timed out");
  });
});
