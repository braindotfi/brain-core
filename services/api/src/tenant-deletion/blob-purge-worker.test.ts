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
interface OutboxRow {
  id: unknown;
  job_id: unknown;
  tenant_id: unknown;
  action: unknown;
  payload: unknown;
  event_key: unknown;
  attempts: number;
  actor: unknown;
  inputs: unknown;
}

function fakePool(
  jobs: BlobPurgeJobRow[],
  opts: { markRowCount?: number } = {},
): { pool: Pool; calls: string[]; outbox: OutboxRow[] } {
  const calls: string[] = [];
  // markRowCount controls the fenced-write outcome: 1 ⇒ lease still held, 0 ⇒
  // lease was stolen by a concurrent reclaim (the worker discards the outcome).
  const markRowCount = opts.markRowCount ?? 1;
  // Models tenant_blob_purge_audit_outbox: transitions INSERT here; the drain
  // SELECTs pending rows one at a time and the publisher emits them. This is how
  // the audit events surface (now via the outbox, not an inline emit).
  const outbox: OutboxRow[] = [];
  const query = vi.fn((sql: string, params?: ReadonlyArray<unknown>) => {
    calls.push(sql);
    if (sql.includes("SET status = 'purging'")) {
      return Promise.resolve({ rows: jobs, rowCount: jobs.length });
    }
    if (sql.includes("INSERT INTO tenant_blob_purge_audit_outbox")) {
      const p = params ?? [];
      outbox.push({
        id: p[0],
        job_id: p[1],
        tenant_id: p[2],
        action: p[3],
        payload: JSON.parse(String(p[4])),
        event_key: p[5],
        attempts: 0,
        actor: p[6] ?? null,
        inputs: JSON.parse(String(p[7] ?? "{}")),
      });
      return Promise.resolve({ rows: [], rowCount: 1 });
    }
    if (sql.includes("FROM tenant_blob_purge_audit_outbox") && sql.includes("status = 'pending'")) {
      const row = outbox.shift();
      return Promise.resolve({ rows: row ? [row] : [], rowCount: row ? 1 : 0 });
    }
    // job status UPDATE (fenced) → markRowCount; BEGIN/COMMIT/outbox marks → 1.
    return Promise.resolve({ rows: [], rowCount: markRowCount });
  });
  const client = { query, release: vi.fn() };
  const pool = {
    connect: vi.fn(() => Promise.resolve(client)),
    query,
  } as unknown as Pool;
  return { pool, calls, outbox };
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
    reclaimed: false,
    ...overrides,
  };
}

describe("runBlobPurgeCycle", () => {
  it("marks a clean purge completed and emits purge_completed", async () => {
    const { pool, calls } = fakePool([job()]);
    const blob = fakeBlob(() => Promise.resolve({ deleted: 5, failures: [] }));
    const audit = new InMemoryAuditEmitter();

    const tally = await runBlobPurgeCycle({ privilegedPool: pool, blob, audit });

    expect(tally).toMatchObject({ claimed: 1, completed: 1, retried: 0, exhausted: 0 });
    expect(blob.purgeTenant).toHaveBeenCalledWith("tnt_01TESTTENANT");
    expect(audit.events.map((e) => e.action)).toContain("tenant_blob.purge_completed");
    expect(calls.some((s) => s.includes("status = 'completed'"))).toBe(true);
  });

  it("terminates as blocked_legal_hold only when every failure is a confirmed legal hold", async () => {
    const { pool, calls } = fakePool([job()]);
    const blob = fakeBlob(() =>
      Promise.resolve({
        deleted: 2,
        failures: [
          {
            path: "tnt_01TESTTENANT/legal/hold.pdf",
            category: "legal_hold" as const,
            retryable: false,
            message: "object is protected by Object Lock",
          },
        ],
      }),
    );
    const audit = new InMemoryAuditEmitter();
    const metrics = { increment: vi.fn(), observe: vi.fn(), gauge: vi.fn() };

    const tally = await runBlobPurgeCycle({
      privilegedPool: pool,
      blob,
      audit,
      metrics: metrics as never,
    });

    expect(tally).toMatchObject({ claimed: 1, completed: 0, blockedLegalHold: 1, retried: 0 });
    expect(audit.events.map((e) => e.action)).toContain("tenant_blob.purge_blocked_legal_hold");
    expect(calls.some((s) => s.includes("status = 'blocked_legal_hold'"))).toBe(true);
    expect(metrics.increment).toHaveBeenCalledWith(
      "brain.tenant.blob_purge.legal_hold.count",
      expect.objectContaining({ tenant_id: "tnt_01TESTTENANT" }),
    );
    // Per-category failure metric is emitted too.
    expect(metrics.increment).toHaveBeenCalledWith(
      "brain.tenant.blob_purge.failure.count",
      expect.objectContaining({ tenant_id: "tnt_01TESTTENANT", category: "legal_hold" }),
    );
  });

  it("RETRIES (does not blocked_legal_hold) when a failure is transient — a 503 is not a hold", async () => {
    const { pool, calls } = fakePool([job({ attempts: 0 })]);
    const blob = fakeBlob(() =>
      Promise.resolve({
        deleted: 1,
        failures: [
          {
            path: "tnt_01TESTTENANT/doc@v2",
            category: "transient" as const,
            retryable: true,
            providerCode: "SlowDown",
            message: "please slow down",
          },
        ],
      }),
    );
    const audit = new InMemoryAuditEmitter();
    const metrics = { increment: vi.fn(), observe: vi.fn(), gauge: vi.fn() };

    const tally = await runBlobPurgeCycle({
      privilegedPool: pool,
      blob,
      audit,
      metrics: metrics as never,
    });

    expect(tally).toMatchObject({ claimed: 1, retried: 1, blockedLegalHold: 0, exhausted: 0 });
    expect(audit.events.map((e) => e.action)).toContain("tenant_blob.purge_retried");
    expect(calls.some((s) => s.includes("status = 'failed'"))).toBe(true);
    expect(calls.some((s) => s.includes("status = 'blocked_legal_hold'"))).toBe(false);
    expect(metrics.increment).toHaveBeenCalledWith(
      "brain.tenant.blob_purge.failure.count",
      expect.objectContaining({ category: "transient" }),
    );
  });

  it("retries a MIXED batch (transient + legal_hold): retryable wins, hold is not lost", async () => {
    const { pool, calls } = fakePool([job({ attempts: 0 })]);
    const blob = fakeBlob(() =>
      Promise.resolve({
        deleted: 0,
        failures: [
          {
            path: "tnt_01TESTTENANT/a@v1",
            category: "legal_hold" as const,
            retryable: false,
            message: "object lock",
          },
          {
            path: "tnt_01TESTTENANT/b@v1",
            category: "transient" as const,
            retryable: true,
            message: "503",
          },
        ],
      }),
    );
    const audit = new InMemoryAuditEmitter();

    const tally = await runBlobPurgeCycle({ privilegedPool: pool, blob, audit });

    // A retryable failure present ⇒ retry the whole job (purgeTenant idempotent);
    // the legal hold is re-encountered next run and only terminal once alone.
    expect(tally).toMatchObject({ claimed: 1, retried: 1, blockedLegalHold: 0 });
    expect(calls.some((s) => s.includes("status = 'blocked_legal_hold'"))).toBe(false);
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
    const blob = fakeBlob(() => Promise.resolve({ deleted: 0, failures: [] }));
    const audit = new InMemoryAuditEmitter();

    const tally = await runBlobPurgeCycle({ privilegedPool: pool, blob, audit });

    expect(tally).toMatchObject({ claimed: 0, completed: 0 });
    expect(blob.purgeTenant).not.toHaveBeenCalled();
    expect(audit.events).toHaveLength(0);
  });

  it("emits purge_reclaimed + a metric for a stale-lease job recovered from a crashed worker", async () => {
    // The claim returns this row with reclaimed=true (its prior lease expired).
    const { pool } = fakePool([job({ reclaimed: true })]);
    const blob = fakeBlob(() => Promise.resolve({ deleted: 4, failures: [] }));
    const audit = new InMemoryAuditEmitter();
    const metrics = { increment: vi.fn(), observe: vi.fn(), gauge: vi.fn() };

    const tally = await runBlobPurgeCycle({
      privilegedPool: pool,
      blob,
      audit,
      metrics: metrics as never,
    });

    expect(tally).toMatchObject({ claimed: 1, completed: 1, reclaimed: 1, leaseLost: 0 });
    expect(audit.events.map((e) => e.action)).toContain("tenant_blob.purge_reclaimed");
    expect(metrics.increment).toHaveBeenCalledWith(
      "brain.tenant.blob_purge.reclaimed.count",
      expect.objectContaining({ tenant_id: "tnt_01TESTTENANT" }),
    );
    // The job still completes its purge after recovery.
    expect(audit.events.map((e) => e.action)).toContain("tenant_blob.purge_completed");
  });

  it("discards the outcome (leaseLost) when a fenced write finds the lease was stolen", async () => {
    // markRowCount 0 ⇒ the fenced UPDATE matched no row: another worker reclaimed
    // this job mid-flight, so our completion must NOT be counted.
    const { pool } = fakePool([job()], { markRowCount: 0 });
    const blob = fakeBlob(() => Promise.resolve({ deleted: 9, failures: [] }));
    const audit = new InMemoryAuditEmitter();
    const metrics = { increment: vi.fn(), observe: vi.fn(), gauge: vi.fn() };

    const tally = await runBlobPurgeCycle({
      privilegedPool: pool,
      blob,
      audit,
      metrics: metrics as never,
    });

    expect(tally).toMatchObject({ claimed: 1, completed: 0, leaseLost: 1 });
    expect(metrics.increment).toHaveBeenCalledWith(
      "brain.tenant.blob_purge.lease_lost.count",
      expect.objectContaining({ tenant_id: "tnt_01TESTTENANT" }),
    );
    // A stolen lease ⇒ ROLLBACK ⇒ nothing enqueued to the outbox.
    expect(audit.events).toHaveLength(0);
  });

  it("writes the audit intent to the outbox with a deterministic event_key, then publishes it", async () => {
    const { pool, outbox, calls } = fakePool([job()]);
    const blob = fakeBlob(() => Promise.resolve({ deleted: 5, failures: [] }));
    const audit = new InMemoryAuditEmitter();

    const tally = await runBlobPurgeCycle({ privilegedPool: pool, blob, audit });

    // Atomic transition: the completed status write and the outbox enqueue are in
    // the same transaction (BEGIN ... UPDATE status='completed' ... INSERT outbox
    // ... COMMIT). After the drain the outbox is emptied and the event delivered.
    expect(tally).toMatchObject({ claimed: 1, completed: 1, auditPublished: 1, auditFailed: 0 });
    expect(outbox).toHaveLength(0); // drained
    expect(calls).toContain("BEGIN");
    expect(calls).toContain("COMMIT");
    // The delivered audit event carries the purge outputs + the deterministic key.
    const ev = audit.events.find((e) => e.action === "tenant_blob.purge_completed");
    expect(ev).toBeDefined();
    expect(ev?.inputs).toMatchObject({ event_key: "tbp_01TESTJOB:tenant_blob.purge_completed:0" });
    expect(ev?.outputs).toMatchObject({ deleted: 5 });
  });

  it("a job commits its terminal state even when audit delivery is down; the row is retried (no sentinel)", async () => {
    const { pool, outbox, calls } = fakePool([job()]);
    const blob = fakeBlob(() => Promise.resolve({ deleted: 5, failures: [] }));
    // Audit service is unavailable: every emit rejects.
    const audit = { emit: vi.fn(() => Promise.reject(new Error("audit service down"))) };
    const metrics = { increment: vi.fn(), observe: vi.fn(), gauge: vi.fn() };

    const tally = await runBlobPurgeCycle({
      privilegedPool: pool,
      blob,
      audit: audit as never,
      metrics: metrics as never,
    });

    // The job is COMPLETED (committed) regardless of audit delivery — a truthful
    // committed result. The audit intent stays in the outbox (delivery failed) to
    // be retried; it is NOT lost and there is no 'audit-emit-failed' sentinel.
    expect(tally).toMatchObject({ completed: 1, auditPublished: 0, auditFailed: 1 });
    expect(calls.some((s) => s.includes("status = 'completed'"))).toBe(true);
    expect(calls.some((s) => s.includes("audit-emit-failed"))).toBe(false);
    // The failed delivery bumped the outbox row's attempt/backoff (not deleted).
    expect(calls.some((s) => s.includes("UPDATE tenant_blob_purge_audit_outbox"))).toBe(true);
    void outbox;
    expect(metrics.increment).toHaveBeenCalledWith(
      "brain.tenant.blob_purge.audit_publish_failed.count",
      expect.objectContaining({ tenant_id: "tnt_01TESTTENANT" }),
    );
  });
});
