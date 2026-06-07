import { describe, expect, it, vi } from "vitest";
import {
  claimDueBlobPurgeJobs,
  enqueueBlobPurgeJob,
  markBlobPurgeBlockedLegalHold,
  markBlobPurgeCompleted,
  markBlobPurgeExhausted,
  markBlobPurgeFailed,
  nextPurgeAttemptDelaySeconds,
  type Queryable,
} from "./blob-purge-repo.js";

function fakeQueryable(rows: unknown[] = []): { client: Queryable; calls: [string, unknown[]][] } {
  const calls: [string, unknown[]][] = [];
  const client: Queryable = {
    query: vi.fn((sql: string, params: ReadonlyArray<unknown> = []) => {
      calls.push([sql, [...params]]);
      return Promise.resolve({ rows, rowCount: rows.length });
    }),
  };
  return { client, calls };
}

describe("nextPurgeAttemptDelaySeconds", () => {
  it("is exponential, capped at 480s", () => {
    expect(nextPurgeAttemptDelaySeconds(1)).toBe(30);
    expect(nextPurgeAttemptDelaySeconds(2)).toBe(60);
    expect(nextPurgeAttemptDelaySeconds(3)).toBe(120);
    expect(nextPurgeAttemptDelaySeconds(4)).toBe(240);
    expect(nextPurgeAttemptDelaySeconds(5)).toBe(480);
    expect(nextPurgeAttemptDelaySeconds(6)).toBe(480);
    expect(nextPurgeAttemptDelaySeconds(10)).toBe(480);
  });
});

describe("enqueueBlobPurgeJob", () => {
  it("inserts ON CONFLICT DO NOTHING and returns the new id", async () => {
    const { client, calls } = fakeQueryable([{ id: "tbp_NEW" }]);
    const id = await enqueueBlobPurgeJob(client, {
      tenantId: "tnt_x",
      blobPrefix: "tnt_x/",
      blobArtifactCount: 3,
    });
    expect(id).toBe("tbp_NEW");
    const [sql, params] = calls[0]!;
    expect(sql).toContain("INSERT INTO tenant_blob_purge_jobs");
    expect(sql).toContain("ON CONFLICT (tenant_id) DO NOTHING");
    expect(params.slice(1)).toEqual(["tnt_x", "tnt_x/", 3]);
  });

  it("returns null when the row already existed (conflict, no RETURNING row)", async () => {
    const { client } = fakeQueryable([]);
    const id = await enqueueBlobPurgeJob(client, {
      tenantId: "tnt_x",
      blobPrefix: "tnt_x/",
      blobArtifactCount: 1,
    });
    expect(id).toBeNull();
  });
});

describe("claimDueBlobPurgeJobs", () => {
  it("claims due pending/failed rows AND reclaims stale leases, fenced on a unique token", async () => {
    const { client, calls } = fakeQueryable([
      {
        id: "tbp_1",
        tenant_id: "tnt_1",
        blob_prefix: "tnt_1/",
        blob_artifact_count: 2,
        status: "purging",
        attempts: 0,
        reclaimed: true,
      },
    ]);
    const claimed = await claimDueBlobPurgeJobs(client, "worker-1:lck_x", 6, 900, 10);
    expect(claimed).toHaveLength(1);
    // The reclaimed flag is threaded back to the worker.
    expect(claimed[0]!.reclaimed).toBe(true);
    const [sql, params] = calls[0]!;
    expect(sql).toContain("SET status = 'purging'");
    expect(sql).toContain("status IN ('pending', 'failed')");
    expect(sql).toContain("next_attempt_at <= now()");
    // Stale-lease reclaim: a 'purging' row whose lease has expired is claimable.
    expect(sql).toContain(
      "status = 'purging' AND locked_at < now() - ($3 || ' seconds')::interval",
    );
    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(sql).toContain("AS reclaimed");
    // lockToken, maxAttempts, leaseSeconds (as text for the interval cast), limit.
    expect(params).toEqual(["worker-1:lck_x", 6, "900", 10]);
  });
});

describe("status transitions (fenced on lockToken)", () => {
  it("markBlobPurgeCompleted sets completed + fences on locked_by + reports lease held", async () => {
    const { client, calls } = fakeQueryable([{ id: "tbp_1" }]); // rowCount 1 ⇒ held
    const held = await markBlobPurgeCompleted(client, "tbp_1", 5, "tok");
    expect(held).toBe(true);
    const [sql, params] = calls[0]!;
    expect(sql).toContain("status = 'completed'");
    expect(sql).toContain("locked_by = $3");
    // No audit_event_ids write: the outbox is the job→audit relation now.
    expect(sql).not.toContain("audit_event_ids");
    expect(params).toEqual(["tbp_1", 5, "tok"]);
  });

  it("a fenced mark reports lease LOST when 0 rows match (stolen lease)", async () => {
    const { client } = fakeQueryable([]); // rowCount 0 ⇒ not held
    const held = await markBlobPurgeCompleted(client, "tbp_1", 5, "stale-tok");
    expect(held).toBe(false);
  });

  it("markBlobPurgeBlockedLegalHold records the surfaced paths + fences", async () => {
    const { client, calls } = fakeQueryable([{ id: "tbp_1" }]);
    const held = await markBlobPurgeBlockedLegalHold(client, "tbp_1", 2, ["a/hold.pdf"], "tok");
    expect(held).toBe(true);
    const [sql, params] = calls[0]!;
    expect(sql).toContain("status = 'blocked_legal_hold'");
    expect(sql).toContain("locked_by = $4");
    expect(params).toEqual(["tbp_1", 2, ["a/hold.pdf"], "tok"]);
  });

  it("markBlobPurgeFailed schedules the backoff, bumps attempts + fences", async () => {
    const { client, calls } = fakeQueryable([{ id: "tbp_1" }]);
    const held = await markBlobPurgeFailed(client, "tbp_1", 2, "azure 503", 60, "tok");
    expect(held).toBe(true);
    const [sql, params] = calls[0]!;
    expect(sql).toContain("status = 'failed'");
    expect(sql).toContain("next_attempt_at = now() + ($4 || ' seconds')::interval");
    expect(sql).toContain("locked_by = $5");
    expect(params).toEqual(["tbp_1", 2, "azure 503", "60", "tok"]);
  });

  it("markBlobPurgeExhausted dead-letters at the cap + fences", async () => {
    const { client, calls } = fakeQueryable([{ id: "tbp_1" }]);
    const held = await markBlobPurgeExhausted(client, "tbp_1", 6, "azure 503", "tok");
    expect(held).toBe(true);
    const [sql, params] = calls[0]!;
    expect(sql).toContain("status = 'exhausted'");
    expect(sql).toContain("locked_by = $4");
    expect(params).toEqual(["tbp_1", 6, "azure 503", "tok"]);
  });
});
