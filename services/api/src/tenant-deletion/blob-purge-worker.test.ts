import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { InMemoryAuditEmitter, type BlobAdapter, type BlobPurgeResult } from "@brain/shared";
import { runBlobPurgeCycle } from "./blob-purge-worker.js";
import type { BlobPurgeJobRow } from "./blob-purge-repo.js";

/**
 * Fake Pool whose `connect().query` and top-level `query` route through one
 * handler. The claim UPDATE (status = 'purging') returns the supplied jobs; the
 * mark UPDATEs return rowCount 1. Every SQL string is captured for assertions.
 */
function fakePool(jobs: BlobPurgeJobRow[]): { pool: Pool; calls: string[] } {
  const calls: string[] = [];
  const query = vi.fn((sql: string) => {
    calls.push(sql);
    if (sql.includes("SET status = 'purging'")) {
      return Promise.resolve({ rows: jobs, rowCount: jobs.length });
    }
    return Promise.resolve({ rows: [], rowCount: 1 });
  });
  const client = { query, release: vi.fn() };
  const pool = {
    connect: vi.fn(() => Promise.resolve(client)),
    query,
  } as unknown as Pool;
  return { pool, calls };
}

function fakeBlob(impl: (tenantId: string) => Promise<BlobPurgeResult>): BlobAdapter {
  return { purgeTenant: vi.fn(impl) } as unknown as BlobAdapter;
}

function job(overrides: Partial<BlobPurgeJobRow> = {}): BlobPurgeJobRow {
  return {
    id: "tbp_01TESTJOB",
    tenant_id: "tnt_01TESTTENANT",
    blob_prefix: "tnt_01TESTTENANT/",
    blob_artifact_count: 3,
    status: "purging",
    attempts: 0,
    ...overrides,
  };
}

describe("runBlobPurgeCycle", () => {
  it("marks a clean purge completed and emits purge_completed", async () => {
    const { pool, calls } = fakePool([job()]);
    const blob = fakeBlob(() => Promise.resolve({ deleted: 5, failed: [] }));
    const audit = new InMemoryAuditEmitter();

    const tally = await runBlobPurgeCycle({ privilegedPool: pool, blob, audit });

    expect(tally).toMatchObject({ claimed: 1, completed: 1, retried: 0, exhausted: 0 });
    expect(blob.purgeTenant).toHaveBeenCalledWith("tnt_01TESTTENANT");
    expect(audit.events.map((e) => e.action)).toContain("tenant_blob.purge_completed");
    expect(calls.some((s) => s.includes("status = 'completed'"))).toBe(true);
  });

  it("terminates as blocked_legal_hold when some paths can't be erased", async () => {
    const { pool, calls } = fakePool([job()]);
    const blob = fakeBlob(() =>
      Promise.resolve({ deleted: 2, failed: ["tnt_01TESTTENANT/legal/hold.pdf"] }),
    );
    const audit = new InMemoryAuditEmitter();
    const metrics = { increment: vi.fn(), observe: vi.fn(), gauge: vi.fn() };

    const tally = await runBlobPurgeCycle({
      privilegedPool: pool,
      blob,
      audit,
      metrics: metrics as never,
    });

    expect(tally).toMatchObject({ claimed: 1, completed: 0, blockedLegalHold: 1 });
    expect(audit.events.map((e) => e.action)).toContain("tenant_blob.purge_blocked_legal_hold");
    expect(calls.some((s) => s.includes("status = 'blocked_legal_hold'"))).toBe(true);
    expect(metrics.increment).toHaveBeenCalledWith(
      "brain.tenant.blob_purge.legal_hold.count",
      expect.objectContaining({ tenant_id: "tnt_01TESTTENANT" }),
    );
  });

  it("schedules a backoff retry when purge throws under the attempt cap", async () => {
    const { pool, calls } = fakePool([job({ attempts: 0 })]);
    const blob = fakeBlob(() => Promise.reject(new Error("azure 503")));
    const audit = new InMemoryAuditEmitter();

    const tally = await runBlobPurgeCycle({ privilegedPool: pool, blob, audit });

    expect(tally).toMatchObject({ claimed: 1, retried: 1, exhausted: 0 });
    expect(audit.events.map((e) => e.action)).toContain("tenant_blob.purge_retried");
    expect(calls.some((s) => s.includes("status = 'failed'"))).toBe(true);
  });

  it("dead-letters (exhausted) when the retry hits the attempt cap", async () => {
    // maxAttempts default 6; attempts=5 → newAttempt 6 → exhausted.
    const { pool, calls } = fakePool([job({ attempts: 5 })]);
    const blob = fakeBlob(() => Promise.reject(new Error("azure 503")));
    const audit = new InMemoryAuditEmitter();
    const metrics = { increment: vi.fn(), observe: vi.fn(), gauge: vi.fn() };

    const tally = await runBlobPurgeCycle({
      privilegedPool: pool,
      blob,
      audit,
      metrics: metrics as never,
    });

    expect(tally).toMatchObject({ claimed: 1, retried: 0, exhausted: 1 });
    expect(audit.events.map((e) => e.action)).toContain("tenant_blob.purge_exhausted");
    expect(calls.some((s) => s.includes("status = 'exhausted'"))).toBe(true);
    expect(metrics.increment).toHaveBeenCalledWith(
      "brain.tenant.blob_purge.exhausted.count",
      expect.objectContaining({ tenant_id: "tnt_01TESTTENANT" }),
    );
  });

  it("is a no-op when no jobs are due", async () => {
    const { pool } = fakePool([]);
    const blob = fakeBlob(() => Promise.resolve({ deleted: 0, failed: [] }));
    const audit = new InMemoryAuditEmitter();

    const tally = await runBlobPurgeCycle({ privilegedPool: pool, blob, audit });

    expect(tally).toMatchObject({ claimed: 0, completed: 0 });
    expect(blob.purgeTenant).not.toHaveBeenCalled();
    expect(audit.events).toHaveLength(0);
  });
});
