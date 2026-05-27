import { describe, expect, it } from "vitest";
import type { Redis } from "ioredis";
import {
  InMemorySlidingWindowRateLimiter,
  RedisSlidingWindowRateLimiter,
} from "./sliding-window.js";

describe("InMemorySlidingWindowRateLimiter", () => {
  it("(a) allows the first `limit` hits, (b) denies the next, (c) allows again after the window", async () => {
    let clock = 1_000_000;
    const limiter = new InMemorySlidingWindowRateLimiter({
      windowSeconds: 3600,
      limit: 60,
      now: () => clock,
    });
    const key = "wiki:annotate:tnt_A:usr_1";

    // (a) 60 hits within the window all pass.
    for (let i = 1; i <= 60; i += 1) {
      clock += 1000; // 1s apart, all inside the hour
      const d = await limiter.hit(key);
      expect(d.allowed).toBe(true);
      expect(d.count).toBe(i);
    }

    // (b) the 61st within the window is denied.
    clock += 1000;
    const denied = await limiter.hit(key);
    expect(denied.allowed).toBe(false);
    expect(denied.count).toBe(61);
    expect(denied.limit).toBe(60);

    // (c) after the window fully elapses, the bucket is empty again.
    clock += 3600 * 1000 + 1;
    const afterWindow = await limiter.hit(key);
    expect(afterWindow.allowed).toBe(true);
    expect(afterWindow.count).toBe(1);
  });

  it("isolates keys (per-tenant/per-principal)", async () => {
    const limiter = new InMemorySlidingWindowRateLimiter({ windowSeconds: 60, limit: 1 });
    expect((await limiter.hit("a")).allowed).toBe(true);
    expect((await limiter.hit("a")).allowed).toBe(false);
    expect((await limiter.hit("b")).allowed).toBe(true);
  });
});

describe("RedisSlidingWindowRateLimiter", () => {
  // Minimal fake ioredis MULTI backed by an in-memory ZSET so the chain logic
  // (zadd → zremrangebyscore → zcard) is exercised for real.
  function fakeRedis() {
    const sets = new Map<string, Array<{ member: string; score: number }>>();
    function multi() {
      const ops: Array<() => [Error | null, unknown]> = [];
      const chain = {
        zadd(key: string, score: number, member: string) {
          ops.push(() => {
            const arr = sets.get(key) ?? [];
            arr.push({ member, score });
            sets.set(key, arr);
            return [null, 1];
          });
          return chain;
        },
        zremrangebyscore(key: string, min: number, max: number) {
          ops.push(() => {
            const arr = (sets.get(key) ?? []).filter((e) => e.score < min || e.score > max);
            sets.set(key, arr);
            return [null, 0];
          });
          return chain;
        },
        zcard(key: string) {
          ops.push(() => [null, (sets.get(key) ?? []).length]);
          return chain;
        },
        pexpire(_key: string, _ms: number) {
          ops.push(() => [null, 1]);
          return chain;
        },
        async exec() {
          return ops.map((op) => op());
        },
      };
      return chain;
    }
    return { multi } as unknown as Redis;
  }

  it("flips allowed=false once the limit is exceeded", async () => {
    let clock = 5_000_000;
    const limiter = new RedisSlidingWindowRateLimiter(fakeRedis(), {
      windowSeconds: 3600,
      limit: 3,
      now: () => clock,
    });
    const key = "k";
    expect((await limiter.hit(key)).allowed).toBe(true); // 1
    clock += 1;
    expect((await limiter.hit(key)).allowed).toBe(true); // 2
    clock += 1;
    expect((await limiter.hit(key)).allowed).toBe(true); // 3
    clock += 1;
    const d = await limiter.hit(key); // 4 > 3
    expect(d.allowed).toBe(false);
    expect(d.count).toBe(4);
  });
});
