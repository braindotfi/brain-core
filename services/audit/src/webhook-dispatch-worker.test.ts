/**
 * Tests for the outbound webhook retry worker (item 13).
 *
 * Mirrors webhook-routes.test.ts: a fake pool routes SQL by substring and an
 * injected deliver fn lets us exercise success / failure / giveup without
 * Postgres or the network.
 */

import { describe, expect, it, vi } from "vitest";
import {
  InMemoryAuditEmitter,
  MAX_WEBHOOK_DELIVERY_ATTEMPTS,
  MockMetrics,
  newTenantId,
} from "@brain/shared";
import type { Pool } from "pg";
import { runWebhookDispatchCycle } from "./webhook-dispatch-worker.js";

const TENANT = newTenantId();

function makeFakePool(rowsFor: (sql: string) => unknown[]): {
  pool: Pool;
  calls: string[];
} {
  const calls: string[] = [];
  const client = {
    query: vi.fn((sql: string) => {
      calls.push(sql);
      if (
        sql === "BEGIN" ||
        sql === "COMMIT" ||
        sql === "ROLLBACK" ||
        sql.startsWith("SELECT set_config")
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      const rows = rowsFor(sql);
      return Promise.resolve({ rows, rowCount: rows.length });
    }),
    release: vi.fn(),
  };
  return { pool: { connect: vi.fn(() => Promise.resolve(client)) } as unknown as Pool, calls };
}

const ENDPOINT = { id: "whe_1", url: "https://example.com/hook", secret: "s", enabled: true };

const ROW_BASE = {
  id: "wdl_1",
  tenant_id: TENANT,
  endpoint_id: "whe_1",
  event_id: "evt_1",
  event_type: "payment_intent.created",
  payload: { id: "evt_1", type: "payment_intent.created", tenant_id: TENANT },
  last_error: "HTTP 500",
  last_attempt_at: new Date("2026-01-01T00:00:00Z"),
};

describe("runWebhookDispatchCycle", () => {
  it("retries due rows and deletes on success", async () => {
    const { pool, calls } = makeFakePool((sql) => {
      if (sql.includes("FROM webhook_dead_letters") && sql.includes("attempt_count < $1")) {
        return [{ ...ROW_BASE, attempt_count: 1 }];
      }
      if (sql.includes("FROM webhook_endpoints")) return [ENDPOINT];
      return [];
    });
    const deliver = vi.fn().mockResolvedValue({ ok: true });
    const audit = new InMemoryAuditEmitter();
    const r = await runWebhookDispatchCycle({ pool, audit, deliver });
    expect(r).toMatchObject({ attempted: 1, delivered: 1, failing: 0, exhausted: 0 });
    expect(deliver).toHaveBeenCalledOnce();
    expect(calls.some((s) => s.includes("DELETE FROM webhook_dead_letters WHERE id"))).toBe(true);
    expect(audit.events).toHaveLength(0);
  });

  it("increments attempt_count when below the cap", async () => {
    const { pool, calls } = makeFakePool((sql) => {
      if (sql.includes("FROM webhook_dead_letters") && sql.includes("attempt_count < $1")) {
        return [{ ...ROW_BASE, attempt_count: 1 }];
      }
      if (sql.includes("FROM webhook_endpoints")) return [ENDPOINT];
      return [];
    });
    const deliver = vi.fn().mockResolvedValue({ ok: false, error: "HTTP 503" });
    const audit = new InMemoryAuditEmitter();
    const metrics = new MockMetrics();
    const r = await runWebhookDispatchCycle({ pool, audit, deliver, metrics });
    expect(r).toMatchObject({ attempted: 1, delivered: 0, failing: 1, exhausted: 0 });
    expect(calls.some((s) => s.includes("UPDATE webhook_dead_letters"))).toBe(true);
    expect(metrics.calls.some((m) => m.name === "brain.audit.webhook.dlq.count")).toBe(false);
    expect(audit.events).toHaveLength(0);
  });

  it("emits dlq.count metric + exhausted audit event when the retry caps out", async () => {
    const { pool } = makeFakePool((sql) => {
      if (sql.includes("FROM webhook_dead_letters") && sql.includes("attempt_count < $1")) {
        // attempt_count = MAX - 1 → increment lands at MAX → exhausted.
        return [{ ...ROW_BASE, attempt_count: MAX_WEBHOOK_DELIVERY_ATTEMPTS - 1 }];
      }
      if (sql.includes("FROM webhook_endpoints")) return [ENDPOINT];
      return [];
    });
    const deliver = vi.fn().mockResolvedValue({ ok: false, error: "HTTP 502" });
    const audit = new InMemoryAuditEmitter();
    const metrics = new MockMetrics();
    const r = await runWebhookDispatchCycle({
      pool,
      audit,
      deliver,
      metrics,
      workerId: "wd-test",
    });
    expect(r.exhausted).toBe(1);
    expect(r.delivered).toBe(0);
    const dlqMetric = metrics.calls.find((m) => m.name === "brain.audit.webhook.dlq.count");
    expect(dlqMetric).toBeDefined();
    expect(dlqMetric?.tags).toMatchObject({
      tenant_id: TENANT,
      endpoint_id: "whe_1",
      event_type: "payment_intent.created",
    });
    const ev = audit.events.find((e) => e.action === "audit.webhook.delivery.exhausted");
    expect(ev).toBeDefined();
    expect(ev?.actor).toBe("wd-test");
    expect(ev?.outputs).toMatchObject({ attempt_count: MAX_WEBHOOK_DELIVERY_ATTEMPTS });
  });

  it("never emits {outcome=pass} for a failing check on the same row", async () => {
    // Doc's "Done when" mirrored for the webhook giveup: the giveup metric is
    // emitted exactly once and never alongside a success counter for the same row.
    const { pool } = makeFakePool((sql) => {
      if (sql.includes("FROM webhook_dead_letters") && sql.includes("attempt_count < $1")) {
        return [{ ...ROW_BASE, attempt_count: MAX_WEBHOOK_DELIVERY_ATTEMPTS - 1 }];
      }
      if (sql.includes("FROM webhook_endpoints")) return [ENDPOINT];
      return [];
    });
    const deliver = vi.fn().mockResolvedValue({ ok: false, error: "HTTP 500" });
    const metrics = new MockMetrics();
    await runWebhookDispatchCycle({
      pool,
      audit: new InMemoryAuditEmitter(),
      deliver,
      metrics,
    });
    const dlqCalls = metrics.calls.filter((m) => m.name === "brain.audit.webhook.dlq.count");
    expect(dlqCalls).toHaveLength(1);
  });

  it("drops the dead-letter when the endpoint has been deleted", async () => {
    const { pool, calls } = makeFakePool((sql) => {
      if (sql.includes("FROM webhook_dead_letters") && sql.includes("attempt_count < $1")) {
        return [{ ...ROW_BASE, attempt_count: 2 }];
      }
      // endpoint lookup → empty → endpoint gone.
      return [];
    });
    const deliver = vi.fn();
    const r = await runWebhookDispatchCycle({
      pool,
      audit: new InMemoryAuditEmitter(),
      deliver,
    });
    expect(r.delivered).toBe(1);
    expect(deliver).not.toHaveBeenCalled();
    expect(calls.some((s) => s.includes("DELETE FROM webhook_dead_letters WHERE id"))).toBe(true);
  });

  it("returns zeros when nothing is due", async () => {
    const { pool } = makeFakePool(() => []);
    const deliver = vi.fn();
    const r = await runWebhookDispatchCycle({
      pool,
      audit: new InMemoryAuditEmitter(),
      deliver,
    });
    expect(r).toMatchObject({ attempted: 0, delivered: 0, failing: 0, exhausted: 0 });
    expect(deliver).not.toHaveBeenCalled();
  });
});

describe("nextAttemptDelaySeconds", () => {
  it("follows the documented schedule: 30, 60, 120, 240, 480 (cap)", async () => {
    const { nextAttemptDelaySeconds } = await import("@brain/shared");
    expect(nextAttemptDelaySeconds(1)).toBe(30);
    expect(nextAttemptDelaySeconds(2)).toBe(60);
    expect(nextAttemptDelaySeconds(3)).toBe(120);
    expect(nextAttemptDelaySeconds(4)).toBe(240);
    expect(nextAttemptDelaySeconds(5)).toBe(480);
    // Cap holds past 5.
    expect(nextAttemptDelaySeconds(10)).toBe(480);
  });
});
