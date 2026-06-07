import { describe, expect, it, vi } from "vitest";
import { closeAllPools, type Closable } from "./close-pools.js";

function fakePool(): Closable & { end: ReturnType<typeof vi.fn> } {
  return { end: vi.fn(async () => undefined) };
}

describe("closeAllPools", () => {
  it("closes one pool once in single-pool (dev) mode even when aliased three times", async () => {
    // wikiPool and privilegedPool default to `pool` in dev — same reference.
    const pool = fakePool();
    const res = await closeAllPools([pool, pool, pool]);
    expect(res).toEqual({ closed: 1, errors: [] });
    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  it("closes each distinct pool once in three-pool (production) mode", async () => {
    const pool = fakePool();
    const wikiPool = fakePool();
    const privilegedPool = fakePool();
    const res = await closeAllPools([pool, wikiPool, privilegedPool]);
    expect(res).toEqual({ closed: 3, errors: [] });
    expect(pool.end).toHaveBeenCalledTimes(1);
    expect(wikiPool.end).toHaveBeenCalledTimes(1);
    expect(privilegedPool.end).toHaveBeenCalledTimes(1);
  });

  it("closes the remaining pools even when one end() rejects", async () => {
    const ok1 = fakePool();
    const bad: Closable = { end: vi.fn(async () => Promise.reject(new Error("boom"))) };
    const ok2 = fakePool();
    const res = await closeAllPools([ok1, bad, ok2]);
    expect(res.closed).toBe(3);
    expect(res.errors).toHaveLength(1);
    expect((res.errors[0] as Error).message).toBe("boom");
    // The healthy pools still closed despite the failure.
    expect(ok1.end).toHaveBeenCalledTimes(1);
    expect(ok2.end).toHaveBeenCalledTimes(1);
  });
});
