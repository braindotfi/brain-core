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
  it("claims with FOR UPDATE SKIP LOCKED over pending/failed due rows", async () => {
    const { client, calls } = fakeQueryable([
      {
        id: "tbp_1",
        tenant_id: "tnt_1",
        blob_prefix: "tnt_1/",
        blob_artifact_count: 2,
        status: "purging",
        attempts: 0,
      },
    ]);
    const claimed = await claimDueBlobPurgeJobs(client, "worker-1", 6, 10);
    expect(claimed).toHaveLength(1);
    const [sql, params] = calls[0]!;
    expect(sql).toContain("SET status = 'purging'");
    expect(sql).toContain("status IN ('pending', 'failed')");
    expect(sql).toContain("next_attempt_at <= now()");
    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(params).toEqual(["worker-1", 6, 10]);
  });
});

describe("status transitions", () => {
  it("markBlobPurgeCompleted sets completed + deleted_count + audit id", async () => {
    const { client, calls } = fakeQueryable();
    await markBlobPurgeCompleted(client, "tbp_1", 5, "evt_1");
    const [sql, params] = calls[0]!;
    expect(sql).toContain("status = 'completed'");
    expect(params).toEqual(["tbp_1", 5, "evt_1"]);
  });

  it("markBlobPurgeBlockedLegalHold records the surfaced paths", async () => {
    const { client, calls } = fakeQueryable();
    await markBlobPurgeBlockedLegalHold(client, "tbp_1", 2, ["a/hold.pdf"], "evt_2");
    const [sql, params] = calls[0]!;
    expect(sql).toContain("status = 'blocked_legal_hold'");
    expect(params).toEqual(["tbp_1", 2, ["a/hold.pdf"], "evt_2"]);
  });

  it("markBlobPurgeFailed schedules the backoff and bumps attempts", async () => {
    const { client, calls } = fakeQueryable();
    await markBlobPurgeFailed(client, "tbp_1", 2, "azure 503", 60, "evt_3");
    const [sql, params] = calls[0]!;
    expect(sql).toContain("status = 'failed'");
    expect(sql).toContain("next_attempt_at = now() + ($4 || ' seconds')::interval");
    expect(params).toEqual(["tbp_1", 2, "azure 503", "60", "evt_3"]);
  });

  it("markBlobPurgeExhausted dead-letters at the cap", async () => {
    const { client, calls } = fakeQueryable();
    await markBlobPurgeExhausted(client, "tbp_1", 6, "azure 503", "evt_4");
    const [sql, params] = calls[0]!;
    expect(sql).toContain("status = 'exhausted'");
    expect(params).toEqual(["tbp_1", 6, "azure 503", "evt_4"]);
  });
});
