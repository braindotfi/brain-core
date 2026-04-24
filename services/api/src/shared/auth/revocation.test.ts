import { describe, expect, it, vi } from "vitest";
import {
  InMemoryRevocationStore,
  RedisRevocationStore,
  redisRevocationKey,
} from "./revocation.js";

describe("redisRevocationKey", () => {
  it("namespaces by jti", () => {
    expect(redisRevocationKey("token_ABC")).toBe("auth:revoked:token_ABC");
  });
});

describe("InMemoryRevocationStore", () => {
  it("marks and retrieves revocations", async () => {
    const store = new InMemoryRevocationStore();
    const exp = Math.floor(Date.now() / 1000) + 60;
    expect(await store.isRevoked("jti1")).toBe(false);
    await store.revoke("jti1", exp);
    expect(await store.isRevoked("jti1")).toBe(true);
  });

  it("self-evicts entries whose expiry has passed", async () => {
    const store = new InMemoryRevocationStore();
    const past = Math.floor(Date.now() / 1000) - 1;
    await store.revoke("old", past);
    expect(await store.isRevoked("old")).toBe(false);
  });
});

describe("RedisRevocationStore", () => {
  it("reads through to redis.get", async () => {
    const redis = {
      get: vi.fn(async (_k: string) => "1"),
      set: vi.fn(),
    };
    const store = new RedisRevocationStore(redis as unknown as import("ioredis").Redis);
    expect(await store.isRevoked("jti1")).toBe(true);
    expect(redis.get).toHaveBeenCalledWith("auth:revoked:jti1");
  });

  it("returns false when redis.get returns null", async () => {
    const redis = {
      get: vi.fn(async () => null),
      set: vi.fn(),
    };
    const store = new RedisRevocationStore(redis as unknown as import("ioredis").Redis);
    expect(await store.isRevoked("missing")).toBe(false);
  });

  it("writes with computed TTL and floors at 1 second", async () => {
    const now = 1_745_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const redis = {
      get: vi.fn(),
      set: vi.fn(async () => "OK"),
    };
    const store = new RedisRevocationStore(redis as unknown as import("ioredis").Redis);

    await store.revoke("jtiA", now + 100);
    expect(redis.set).toHaveBeenLastCalledWith("auth:revoked:jtiA", "1", "EX", 100);

    // Past expiry collapses to TTL=1 (not 0, which Redis would reject).
    await store.revoke("jtiB", now - 10);
    expect(redis.set).toHaveBeenLastCalledWith("auth:revoked:jtiB", "1", "EX", 1);

    vi.restoreAllMocks();
  });
});
