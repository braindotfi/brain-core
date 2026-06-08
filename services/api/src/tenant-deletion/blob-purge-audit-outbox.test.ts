import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { InMemoryAuditEmitter } from "@brain/shared";
import {
  claimPendingAuditOutbox,
  countAuditOutboxByStatus,
  drainAuditOutbox,
  enqueueAuditOutbox,
  listAuditOutbox,
  markAuditOutboxFailed,
  markAuditOutboxPublished,
  nextOutboxAttemptDelaySeconds,
  operatorReplayExhaustedAuditOutbox,
  replayExhaustedAuditOutbox,
  reportAuditOutboxHealth,
  type AuditOutboxRow,
  type AuditOutboxRowSummary,
  type OperatorReplayDeps,
} from "./blob-purge-audit-outbox.js";
import type { Queryable } from "./blob-purge-repo.js";

function fakeQ(rows: unknown[] = []): { client: Queryable; calls: [string, unknown[]][] } {
  const calls: [string, unknown[]][] = [];
  const client: Queryable = {
    query: vi.fn((sql: string, params: ReadonlyArray<unknown> = []) => {
      calls.push([sql, [...params]]);
      return Promise.resolve({ rows, rowCount: rows.length });
    }),
  };
  return { client, calls };
}

describe("nextOutboxAttemptDelaySeconds", () => {
  it("is exponential, capped at 480s", () => {
    expect(nextOutboxAttemptDelaySeconds(1)).toBe(30);
    expect(nextOutboxAttemptDelaySeconds(2)).toBe(60);
    expect(nextOutboxAttemptDelaySeconds(5)).toBe(480);
    expect(nextOutboxAttemptDelaySeconds(12)).toBe(480);
  });
});

describe("enqueueAuditOutbox", () => {
  it("inserts ON CONFLICT (event_key) DO NOTHING with a jsonb payload", async () => {
    const { client, calls } = fakeQ();
    await enqueueAuditOutbox(client, {
      jobId: "tbp_1",
      tenantId: "tnt_1",
      action: "tenant_blob.purge_completed",
      payload: { deleted: 4 },
      eventKey: "tbp_1:tenant_blob.purge_completed:0",
    });
    const [sql, params] = calls[0]!;
    expect(sql).toContain("INSERT INTO tenant_blob_purge_audit_outbox");
    expect(sql).toContain("ON CONFLICT (event_key) DO NOTHING");
    expect(sql).toContain("$5::jsonb");
    // id is generated; the rest are passed through, payload + inputs JSON-encoded.
    // No actor/inputs supplied ⇒ null actor + "{}" inputs.
    expect(params.slice(1)).toEqual([
      "tbp_1",
      "tnt_1",
      "tenant_blob.purge_completed",
      JSON.stringify({ deleted: 4 }),
      "tbp_1:tenant_blob.purge_completed:0",
      null,
      JSON.stringify({}),
    ]);
  });
});

describe("claimPendingAuditOutbox", () => {
  it("selects pending due rows under the cap, FOR UPDATE SKIP LOCKED", async () => {
    const { client, calls } = fakeQ([]);
    await claimPendingAuditOutbox(client, 12, 1);
    const [sql, params] = calls[0]!;
    expect(sql).toContain("status = 'pending'");
    expect(sql).toContain("next_attempt_at <= now()");
    expect(sql).toContain("attempts < $1");
    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(params).toEqual([12, 1]);
  });
});

describe("mark transitions", () => {
  it("markAuditOutboxPublished records the real audit_event_id", async () => {
    const { client, calls } = fakeQ();
    await markAuditOutboxPublished(client, "tbo_1", "evt_real");
    const [sql, params] = calls[0]!;
    expect(sql).toContain("status = 'published'");
    expect(sql).toContain("audit_event_id = $2");
    expect(params).toEqual(["tbo_1", "evt_real"]);
  });

  it("markAuditOutboxFailed bumps attempts + schedules backoff", async () => {
    const { client, calls } = fakeQ();
    await markAuditOutboxFailed(client, "tbo_1", 3, "audit down", 120);
    const [sql, params] = calls[0]!;
    expect(sql).toContain("attempts = $2");
    expect(sql).toContain("next_attempt_at = now() + ($4 || ' seconds')::interval");
    expect(params).toEqual(["tbo_1", 3, "audit down", "120"]);
  });
});

function row(overrides: Partial<AuditOutboxRow> = {}): AuditOutboxRow {
  return {
    id: "tbo_1",
    job_id: "tbp_1",
    tenant_id: "tnt_1",
    action: "tenant_blob.purge_completed",
    payload: { deleted: 3 },
    event_key: "tbp_1:tenant_blob.purge_completed:0",
    attempts: 0,
    actor: null,
    inputs: {},
    ...overrides,
  };
}

/** Pool whose pending-claim SELECT serves `pending` one at a time, then empty. */
function drainPool(pending: AuditOutboxRow[]): { pool: Pool; calls: string[] } {
  const remaining = [...pending];
  const calls: string[] = [];
  const query = vi.fn((sql: string) => {
    calls.push(sql);
    if (sql.includes("FROM tenant_blob_purge_audit_outbox") && sql.includes("status = 'pending'")) {
      const r = remaining.shift();
      return Promise.resolve({ rows: r ? [r] : [], rowCount: r ? 1 : 0 });
    }
    return Promise.resolve({ rows: [], rowCount: 1 });
  });
  const client = { query, release: vi.fn() };
  return {
    pool: { connect: vi.fn(() => Promise.resolve(client)), query } as unknown as Pool,
    calls,
  };
}

describe("drainAuditOutbox", () => {
  it("delivers a pending row to the audit service and marks it published", async () => {
    const { pool, calls } = drainPool([row()]);
    const audit = new InMemoryAuditEmitter();

    const res = await drainAuditOutbox({ privilegedPool: pool, audit, workerId: "w1" });

    expect(res).toEqual({ published: 1, failed: 0, exhausted: 0 });
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({
      action: "tenant_blob.purge_completed",
      tenantId: "tnt_1",
      outputs: { deleted: 3 },
    });
    expect(calls.some((s) => s.includes("status = 'published'"))).toBe(true);
  });

  it("delivers an explicit-actor row (e.g. tenant.deleted) with its actor + merged inputs", async () => {
    const { pool } = drainPool([
      row({
        job_id: null,
        action: "tenant.deleted",
        actor: "usr_requester",
        inputs: { tenant_id: "tnt_1", requested_by: "usr_requester" },
        payload: { total_rows_deleted: 5 },
        event_key: "tnt_1:tenant.deleted",
      }),
    ]);
    const audit = new InMemoryAuditEmitter();

    const res = await drainAuditOutbox({ privilegedPool: pool, audit, workerId: "w1" });

    expect(res.published).toBe(1);
    const ev = audit.events[0]!;
    expect(ev.action).toBe("tenant.deleted");
    expect(ev.actor).toBe("usr_requester"); // explicit actor, not the worker id
    expect(ev.inputs).toMatchObject({
      tenant_id: "tnt_1",
      requested_by: "usr_requester",
      event_key: "tnt_1:tenant.deleted",
    });
    // job_id null ⇒ no tenant_blob_purge_job_id key
    expect(ev.inputs).not.toHaveProperty("tenant_blob_purge_job_id");
    // The event carries the outbox event_key as its idempotency key.
    expect(ev.idempotencyKey).toBe("tnt_1:tenant.deleted");
  });

  it("on audit failure, records the failure (backoff) and does NOT mark published", async () => {
    const { pool, calls } = drainPool([row()]);
    const audit = { emit: vi.fn(() => Promise.reject(new Error("audit down"))) };
    const metrics = { increment: vi.fn(), observe: vi.fn(), gauge: vi.fn() };

    const res = await drainAuditOutbox({
      privilegedPool: pool,
      audit: audit as never,
      workerId: "w1",
      metrics: metrics as never,
    });

    expect(res).toEqual({ published: 0, failed: 1, exhausted: 0 });
    expect(calls.some((s) => s.includes("attempts = $2"))).toBe(true);
    expect(calls.some((s) => s.includes("status = 'published'"))).toBe(false);
    expect(metrics.increment).toHaveBeenCalledWith(
      "brain.tenant.blob_purge.audit_publish_failed.count",
      expect.objectContaining({ tenant_id: "tnt_1" }),
    );
  });

  it("is a no-op when the outbox is empty", async () => {
    const { pool } = drainPool([]);
    const audit = new InMemoryAuditEmitter();
    const res = await drainAuditOutbox({ privilegedPool: pool, audit, workerId: "w1" });
    expect(res).toEqual({ published: 0, failed: 0, exhausted: 0 });
    expect(audit.events).toHaveLength(0);
  });

  it("dead-letters to exhausted at the attempt cap (critical metric, not silent pending)", async () => {
    // maxAttempts 1 + a row at attempts 0 ⇒ the first failed delivery hits the cap.
    const { pool, calls } = drainPool([row({ attempts: 0 })]);
    const audit = { emit: vi.fn(() => Promise.reject(new Error("audit down"))) };
    const metrics = { increment: vi.fn(), observe: vi.fn(), gauge: vi.fn() };

    const res = await drainAuditOutbox({
      privilegedPool: pool,
      audit: audit as never,
      workerId: "w1",
      metrics: metrics as never,
      maxAttempts: 1,
    });

    expect(res).toEqual({ published: 0, failed: 0, exhausted: 1 });
    // The row moved to an explicit, observable terminal state (not pending).
    expect(calls.some((s) => s.includes("status = 'exhausted'"))).toBe(true);
    expect(calls.some((s) => s.includes("status = 'published'"))).toBe(false);
    // ...with a critical metric so undelivered mandatory evidence is loud.
    expect(metrics.increment).toHaveBeenCalledWith(
      "brain.tenant.blob_purge.audit_outbox_exhausted.count",
      expect.objectContaining({ tenant_id: "tnt_1" }),
    );
  });

  it("replayExhaustedAuditOutbox requeues exhausted rows to pending", async () => {
    const { client, calls } = fakeQ([{ id: "tbo_1" }, { id: "tbo_2" }]);
    const n = await replayExhaustedAuditOutbox(client, 50);
    expect(n).toBe(2);
    const [sql, params] = calls[0]!;
    expect(sql).toContain("SET status = 'pending', attempts = 0");
    expect(sql).toContain("status = 'exhausted'");
    expect(params).toEqual([50]);
  });

  it("countAuditOutboxByStatus counts rows in a status", async () => {
    const { client, calls } = fakeQ([{ n: 3 }]);
    const n = await countAuditOutboxByStatus(client, "exhausted");
    expect(n).toBe(3);
    const [sql, params] = calls[0]!;
    expect(sql).toContain("count(*)");
    expect(params).toEqual(["exhausted"]);
  });
});

describe("reportAuditOutboxHealth", () => {
  function healthPool(row: {
    pending: number;
    exhausted: number;
    oldest_pending_age_s: number;
    oldest_exhausted_age_s: number;
  }): { pool: Pool; sql: string[] } {
    const sql: string[] = [];
    const pool = {
      query: vi.fn(async (text: string) => {
        sql.push(text);
        return { rows: [row], rowCount: 1 };
      }),
    } as unknown as Pool;
    return { pool, sql };
  }

  it("emits gauges and returns the snapshot, with no log when nothing is exhausted", async () => {
    const { pool, sql } = healthPool({
      pending: 2,
      exhausted: 0,
      oldest_pending_age_s: 41.5,
      oldest_exhausted_age_s: 0,
    });
    const metrics = { increment: vi.fn(), observe: vi.fn(), gauge: vi.fn() };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const health = await reportAuditOutboxHealth({
      privilegedPool: pool,
      metrics: metrics as never,
    });

    expect(health).toEqual({
      pending: 2,
      exhausted: 0,
      oldestPendingAgeSeconds: 41.5,
      oldestExhaustedAgeSeconds: 0,
    });
    expect(metrics.gauge).toHaveBeenCalledWith("brain.audit.outbox.pending.count", 2);
    expect(metrics.gauge).toHaveBeenCalledWith("brain.audit.outbox.exhausted.count", 0);
    expect(metrics.gauge).toHaveBeenCalledWith(
      "brain.audit.outbox.oldest_pending_age_seconds",
      41.5,
    );
    // Counts are per-status FILTER aggregates over the whole table.
    expect(sql.some((s) => s.includes("FILTER (WHERE status = 'exhausted')"))).toBe(true);
    // Clean evidence => no critical log.
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("logs critical when exhausted mandatory audit rows exist", async () => {
    const { pool } = healthPool({
      pending: 0,
      exhausted: 3,
      oldest_pending_age_s: 0,
      oldest_exhausted_age_s: 7200,
    });
    const metrics = { increment: vi.fn(), observe: vi.fn(), gauge: vi.fn() };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const health = await reportAuditOutboxHealth({
      privilegedPool: pool,
      metrics: metrics as never,
    });

    expect(health.exhausted).toBe(3);
    expect(metrics.gauge).toHaveBeenCalledWith("brain.audit.outbox.exhausted.count", 3);
    expect(metrics.gauge).toHaveBeenCalledWith(
      "brain.audit.outbox.oldest_exhausted_age_seconds",
      7200,
    );
    expect(errSpy).toHaveBeenCalled(); // exhausted > 0 => critical log
    errSpy.mockRestore();
  });
});

describe("operator recovery surface", () => {
  function summary(over: Partial<AuditOutboxRowSummary> = {}): AuditOutboxRowSummary {
    return {
      id: "tbo_1",
      tenant_id: "tnt_a",
      event_key: "tnt_a:purge_completed",
      action: "tenant_blob.purge_completed",
      status: "exhausted",
      attempts: 12,
      age_seconds: 7200,
      ...over,
    };
  }

  /** Pool whose connect() yields a client returning `rows` for the FOR UPDATE select. */
  function fakeReplayPool(rows: AuditOutboxRowSummary[]): {
    pool: OperatorReplayDeps["privilegedPool"];
    sql: string[];
    calls: [string, unknown[]][];
  } {
    const sql: string[] = [];
    const calls: [string, unknown[]][] = [];
    const client = {
      query: vi.fn(async (text: string, p: ReadonlyArray<unknown> = []) => {
        sql.push(text.trim().split("\n")[0]!.trim());
        calls.push([text, [...p]]);
        if (text.includes("FOR UPDATE")) return { rows, rowCount: rows.length };
        return { rows: [], rowCount: rows.length };
      }),
      release: vi.fn(),
    };
    return { pool: { connect: async () => client }, sql, calls };
  }

  it("listAuditOutbox filters by tenant + age and returns non-sensitive metadata", async () => {
    const { client, calls } = fakeQ([summary()]);
    const rows = await listAuditOutbox(client, {
      status: "exhausted",
      filter: { tenantId: "tnt_a", olderThanSeconds: 3600 },
      limit: 50,
    });
    expect(rows).toHaveLength(1);
    const [sql, params] = calls[0]!;
    expect(sql).toContain("status = $1");
    expect(sql).toContain("tenant_id = $2");
    expect(sql).toContain("seconds')::interval");
    expect(sql).not.toContain("payload"); // never selects the payload
    expect(params).toEqual(["exhausted", "tnt_a", "3600", 50]);
  });

  it("dry-run lists matching rows without mutating or enqueuing audit", async () => {
    const { pool, sql } = fakeReplayPool([summary()]);
    const res = await operatorReplayExhaustedAuditOutbox(
      { privilegedPool: pool },
      { operator: "ops@brain", dryRun: true },
    );
    expect(res.dryRun).toBe(true);
    expect(res.replayed).toHaveLength(1);
    expect(sql).toContain("ROLLBACK");
    expect(sql.some((s) => s.startsWith("UPDATE"))).toBe(false);
    expect(sql.some((s) => s.startsWith("INSERT"))).toBe(false); // no audit intent enqueued
  });

  it("requeues exhausted rows AND enqueues the replay audit intent in the same transaction", async () => {
    const rows = [
      summary({ id: "tbo_1", tenant_id: "tnt_a", event_key: "tnt_a:k1" }),
      summary({ id: "tbo_2", tenant_id: "tnt_a", event_key: "tnt_a:k2" }),
      summary({ id: "tbo_3", tenant_id: "tnt_b", event_key: "tnt_b:k1" }),
    ];
    const { pool, sql, calls } = fakeReplayPool(rows);

    const res = await operatorReplayExhaustedAuditOutbox(
      { privilegedPool: pool },
      { operator: "ops@brain" },
    );

    expect(res.dryRun).toBe(false);
    expect(res.replayed).toHaveLength(3);

    // The audit evidence is enqueued (not emitted post-commit) BEFORE the COMMIT,
    // so the requeue and its audit intent are atomic (Codex fca9ac8 P1 #3).
    const updateIdx = sql.findIndex((s) => s.startsWith("UPDATE"));
    const insertIdxs = sql.map((s, i) => (s.startsWith("INSERT") ? i : -1)).filter((i) => i >= 0);
    const commitIdx = sql.indexOf("COMMIT");
    expect(updateIdx).toBeGreaterThanOrEqual(0);
    expect(insertIdxs).toHaveLength(2); // one intent per affected tenant
    expect(Math.max(...insertIdxs)).toBeLessThan(commitIdx); // enqueued before commit

    // Each enqueued intent carries the operator + that tenant's event_keys.
    const inserts = calls.filter(([t]) => t.includes("INSERT INTO tenant_blob_purge_audit_outbox"));
    const tntA = inserts.find(([, p]) => p[2] === "tnt_a")!;
    expect(tntA[1][3]).toBe("audit.outbox.replayed"); // action
    expect(tntA[1][6]).toBe("ops@brain"); // actor
    expect(String(tntA[1][5])).toMatch(/^audit\.outbox\.replayed:.*:tnt_a$/); // event_key
    expect(JSON.parse(String(tntA[1][7]))).toMatchObject({
      operator: "ops@brain",
      count: 2,
      event_keys: ["tnt_a:k1", "tnt_a:k2"],
    });
    const tntB = inserts.find(([, p]) => p[2] === "tnt_b")!;
    expect(JSON.parse(String(tntB[1][7]))).toMatchObject({ count: 1 });
  });

  it("is a no-op (no requeue, no audit intent) when nothing matches", async () => {
    const { pool, sql } = fakeReplayPool([]);
    const res = await operatorReplayExhaustedAuditOutbox(
      { privilegedPool: pool },
      { operator: "ops@brain" },
    );
    expect(res.replayed).toEqual([]);
    expect(sql.some((s) => s.startsWith("UPDATE"))).toBe(false);
    expect(sql.some((s) => s.startsWith("INSERT"))).toBe(false);
  });
});
