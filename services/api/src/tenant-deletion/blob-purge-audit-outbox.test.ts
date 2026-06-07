import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { InMemoryAuditEmitter } from "@brain/shared";
import {
  claimPendingAuditOutbox,
  countAuditOutboxByStatus,
  drainAuditOutbox,
  enqueueAuditOutbox,
  markAuditOutboxFailed,
  markAuditOutboxPublished,
  nextOutboxAttemptDelaySeconds,
  replayExhaustedAuditOutbox,
  type AuditOutboxRow,
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
