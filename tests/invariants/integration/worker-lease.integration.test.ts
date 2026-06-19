/**
 * Worker advisory-lease single-flight (R-13 follow-up).
 *
 * Proves against a real Postgres that `leasedCycle` makes idempotent pollers
 * multi-replica safe: two cycles on the same lock key invoked concurrently run
 * exactly once (the loser skips because the lock is held), and once both settle
 * the lock is freed so a later invocation runs again (failover/handover).
 *
 * Requires DATABASE_URL; skips otherwise so `pnpm test` stays hermetic.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { leasedCycle } from "@brain/shared";

const DB_URL = process.env.DATABASE_URL;
const suite = DB_URL !== undefined && DB_URL !== "" ? describe : describe.skip;

suite("worker advisory lease (integration -- requires DATABASE_URL)", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: DB_URL, max: 5, application_name: "worker-lease-it" });
  });

  afterAll(async () => {
    if (pool !== undefined) await pool.end();
  });

  it("runs only one of two concurrent cycles, then frees the lock for the next", async () => {
    // Unique key per run so parallel test files on the same DB never collide.
    const key = `brain_worker_lease_it_${process.pid}_${String(Math.trunc(performance.now()))}`;
    let runs = 0;
    const slowCycle = async (): Promise<void> => {
      runs += 1;
      await new Promise((r) => setTimeout(r, 200));
    };

    // Two replicas tick at the same time: only the lock holder runs.
    await Promise.all([
      leasedCycle({ pool, lockKey: key, cycle: slowCycle })(),
      leasedCycle({ pool, lockKey: key, cycle: slowCycle })(),
    ]);
    expect(runs).toBe(1);

    // Lock released after both settled — a fresh tick runs again (handover).
    await leasedCycle({ pool, lockKey: key, cycle: slowCycle })();
    expect(runs).toBe(2);
  });
});
