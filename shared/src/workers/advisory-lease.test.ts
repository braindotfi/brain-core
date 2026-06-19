import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { leasedCycle } from "./advisory-lease.js";

/** Fake pool whose single client reports `locked` for pg_try_advisory_lock. */
function fakePool(locked: boolean) {
  const queries: string[] = [];
  const client = {
    query: vi.fn(async (sql: string) => {
      queries.push(sql);
      return sql.includes("pg_try_advisory_lock") ? { rows: [{ locked }] } : { rows: [] };
    }),
    release: vi.fn(),
  };
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
  return { pool, client, queries };
}

function metricsSpy() {
  return {
    increment: vi.fn(),
    gauge: vi.fn(),
    histogram: vi.fn(),
    duration: vi.fn(),
    close: vi.fn(),
  };
}

describe("leasedCycle", () => {
  it("runs the cycle, then unlocks and releases, when the lock is granted", async () => {
    const { pool, client, queries } = fakePool(true);
    const cycle = vi.fn(async () => {});
    await leasedCycle({ pool, lockKey: "brain_worker_test", cycle })();

    expect(cycle).toHaveBeenCalledOnce();
    expect(queries.some((q) => q.includes("pg_try_advisory_lock"))).toBe(true);
    expect(queries.some((q) => q.includes("pg_advisory_unlock"))).toBe(true);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("skips the cycle (no unlock) and releases when the lock is held elsewhere", async () => {
    const { pool, client, queries } = fakePool(false);
    const cycle = vi.fn(async () => {});
    const metrics = metricsSpy();
    await leasedCycle({ pool, lockKey: "brain_worker_test", cycle, metrics })();

    expect(cycle).not.toHaveBeenCalled();
    expect(queries.some((q) => q.includes("pg_advisory_unlock"))).toBe(false);
    expect(client.release).toHaveBeenCalledOnce();
    expect(metrics.increment).toHaveBeenCalledWith("brain.worker.lease.skipped", {
      worker: "brain_worker_test",
    });
  });

  it("unlocks and releases even when the cycle throws (no lock/connection leak)", async () => {
    const { pool, client, queries } = fakePool(true);
    const boom = new Error("cycle failed");
    await expect(
      leasedCycle({
        pool,
        lockKey: "brain_worker_test",
        cycle: async () => {
          throw boom;
        },
      })(),
    ).rejects.toThrow(boom);

    expect(queries.some((q) => q.includes("pg_advisory_unlock"))).toBe(true);
    expect(client.release).toHaveBeenCalledOnce();
  });
});
