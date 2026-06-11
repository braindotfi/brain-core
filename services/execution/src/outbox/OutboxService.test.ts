/**
 * OutboxService unit tests.
 *
 * Exercises the SQL-shape + control flow of each method against a fake query
 * client (no Postgres). The real `FOR UPDATE SKIP LOCKED` claim semantics, the
 * UNIQUE(tenant_id, idempotency_key) constraint, and RLS are validated in a pg
 * integration test (blocked in this sandbox — see worker.test.ts SANDBOX NOTE).
 */

import { describe, expect, it, vi } from "vitest";
import { newPaymentIntentId, newTenantId, type TenantScopedClient } from "@brain/shared";
import {
  OutboxService,
  payloadHash,
  MAX_DISPATCH_ATTEMPTS,
  MAX_TOTAL_DISPATCH_ATTEMPTS,
} from "./OutboxService.js";

const TENANT = newTenantId();
const PI = newPaymentIntentId();

/** Routes each query to a canned result by SQL substring; records all calls. */
function fakeClient(handler: (sql: string, values: unknown[]) => unknown[]): {
  client: TenantScopedClient;
  calls: Array<{ sql: string; values: unknown[] }>;
} {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const client = {
    query: vi.fn(async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      const rows = handler(sql, values);
      return { rows, rowCount: rows.length };
    }),
  } as unknown as TenantScopedClient;
  return { client, calls };
}

const enqueueInput = {
  paymentIntentId: PI,
  rail: "bank_ach",
  idempotencyKey: `pi:${PI}:pd_x`,
  payload: { amount: "100.00", currency: "USD" },
  auditBeforeId: "evt_before",
};

describe("OutboxService.enqueue", () => {
  it("inserts a pending row and returns created:true", async () => {
    const svc = new OutboxService();
    const { client, calls } = fakeClient((sql) =>
      sql.includes("INSERT INTO execution_outbox") ? [{ id: "exo_new" }] : [],
    );
    const r = await svc.enqueue(client, TENANT, enqueueInput);
    expect(r).toEqual({ id: "exo_new", created: true });

    const insert = calls.find((c) => c.sql.includes("INSERT INTO execution_outbox"));
    // Idempotent insert + tenant isolation by RLS (tenant_id is a column, not a WHERE filter).
    expect(insert?.sql).toContain("ON CONFLICT (tenant_id, idempotency_key) DO NOTHING");
    expect(insert?.sql).toContain("'pending'");
    // payload_hash is the sha256 of the canonical payload.
    expect((insert?.values[6] as Buffer).equals(payloadHash(enqueueInput.payload))).toBe(true);
  });

  it("is idempotent: on conflict returns the existing row id with created:false", async () => {
    const svc = new OutboxService();
    const { client } = fakeClient((sql) => {
      if (sql.includes("INSERT INTO execution_outbox")) return []; // DO NOTHING → no row
      if (sql.includes("SELECT id FROM execution_outbox")) return [{ id: "exo_existing" }];
      return [];
    });
    const r = await svc.enqueue(client, TENANT, enqueueInput);
    expect(r).toEqual({ id: "exo_existing", created: false });
  });

  it("throws if the conflict path finds no existing row (should be impossible)", async () => {
    const svc = new OutboxService();
    const { client } = fakeClient(() => []); // insert no-op AND select empty
    await expect(svc.enqueue(client, TENANT, enqueueInput)).rejects.toThrow(/no existing row/);
  });
});

describe("OutboxService.claimNext", () => {
  it("uses FOR UPDATE SKIP LOCKED over pending/reconciling and stamps the lock", async () => {
    const svc = new OutboxService();
    const { client, calls } = fakeClient((sql) =>
      sql.includes("UPDATE execution_outbox") ? [{ id: "exo_1", status: "dispatching" }] : [],
    );
    const rows = await svc.claimNext(client, "worker_a", 5);
    expect(rows).toHaveLength(1);

    const claim = calls[0];
    expect(claim?.sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(claim?.sql).toContain("status IN ('pending', 'reconciling')");
    expect(claim?.sql).toContain("status = 'dispatching'");
    expect(claim?.values).toEqual(["worker_a", 5, MAX_TOTAL_DISPATCH_ATTEMPTS]);
  });

  it("bounds the retry loop: backoff window + total-attempt ceiling in the claim", async () => {
    const svc = new OutboxService();
    const { client, calls } = fakeClient(() => []);
    await svc.claimNext(client, "worker_a", 5);

    const claim = calls[0];
    // Hard ceiling: a row at MAX_TOTAL_DISPATCH_ATTEMPTS is never re-picked.
    expect(claim?.sql).toContain("attempt_count < $3");
    // Exponential backoff (mirrors the webhook DLQ schedule, 30s·2^(n-1) cap 480s);
    // never-attempted rows (last_attempt_at NULL) stay immediately claimable.
    expect(claim?.sql).toContain("last_attempt_at IS NULL");
    expect(claim?.sql).toContain("LEAST(30 * power(2, attempt_count - 1), 480)");
  });
});

describe("OutboxService terminal transitions", () => {
  it("markDispatched stores receipt, audit-after, and execution id", async () => {
    const svc = new OutboxService();
    const { client, calls } = fakeClient(() => []);
    await svc.markDispatched(client, "exo_1", {
      railReceipt: { rail: "ach", stub: true },
      auditAfterId: "evt_after",
      executionId: "exec_1",
    });
    const q = calls[0];
    expect(q?.sql).toContain("status = 'dispatched'");
    expect(q?.values).toEqual([
      "exo_1",
      JSON.stringify({ rail: "ach", stub: true }),
      "evt_after",
      "exec_1",
    ]);
  });

  it("markSettled closes the row", async () => {
    const svc = new OutboxService();
    const { client, calls } = fakeClient(() => []);
    await svc.markSettled(client, "exo_1");
    expect(calls[0]?.sql).toContain("status = 'settled'");
  });

  it("markFailed bumps attempt_count, stamps the backoff clock, and reports it", async () => {
    const svc = new OutboxService();
    const { client, calls } = fakeClient(() => [{ attempt_count: 1 }]);
    const n = await svc.markFailed(client, "exo_1", "rail timeout");
    expect(n).toBe(1);
    const q = calls[0];
    // Threshold logic lives in SQL so it is atomic with the increment.
    expect(q?.sql).toContain("attempt_count = attempt_count + 1");
    expect(q?.sql).toContain("'reconciling'");
    expect(q?.sql).toContain("last_attempt_at = now()");
    expect(q?.values).toEqual(["exo_1", "rail timeout", MAX_DISPATCH_ATTEMPTS]);
  });

  it("markReconciling forces the reconcile state, counts the attempt, clears the lock", async () => {
    const svc = new OutboxService();
    const { client, calls } = fakeClient(() => [{ attempt_count: 4 }]);
    const n = await svc.markReconciling(client, "exo_1", "receipt failed validation");
    expect(n).toBe(4);
    const q = calls[0];
    expect(q?.sql).toContain("status = 'reconciling'");
    expect(q?.sql).toContain("attempt_count = attempt_count + 1");
    expect(q?.sql).toContain("last_attempt_at = now()");
    expect(q?.sql).toContain("locked_by = NULL");
  });

  it("markPermanentlyFailed parks the row terminally with the decoded reason", async () => {
    const svc = new OutboxService();
    const { client, calls } = fakeClient(() => []);
    await svc.markPermanentlyFailed(client, "exo_1", {
      error: "deterministic_revert ExceedsPerTxCap(): on-chain execute reverted",
      auditAfterId: "evt_after",
    });
    const q = calls[0];
    expect(q?.sql).toContain("status = 'failed'");
    expect(q?.sql).toContain("attempt_count = attempt_count + 1");
    expect(q?.sql).toContain("completed_at = now()");
    expect(q?.sql).toContain("locked_by = NULL");
    expect(q?.values).toEqual([
      "exo_1",
      "deterministic_revert ExceedsPerTxCap(): on-chain execute reverted",
      "evt_after",
    ]);
  });

  it("reclaimStale returns stale dispatching rows to pending (crash recovery)", async () => {
    const svc = new OutboxService();
    const { client, calls } = fakeClient((sql) =>
      sql.includes("UPDATE execution_outbox") ? [{ id: "exo_stale" }] : [],
    );
    const rows = await svc.reclaimStale(client, 300);
    expect(rows).toHaveLength(1);
    const q = calls[0];
    // Recovers both in-flight states back to pending.
    expect(q?.sql).toContain("status IN ('dispatching', 'dispatched')");
    expect(q?.sql).toContain("status = 'pending'");
    expect(q?.sql).toContain("locked_at <");
    expect(q?.values).toEqual([300]);
  });
});
