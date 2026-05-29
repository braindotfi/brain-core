import { describe, expect, it, vi } from "vitest";
import { InMemoryAuditEmitter, newTenantId, newUserId } from "@brain/shared";
import type { Pool } from "pg";
import { TenantDeletionService } from "./service.js";

const TENANT = newTenantId();
const USER = newUserId();

function fakePool(deletePerTable: Record<string, number>): Pool {
  const client = {
    query: vi.fn((sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      const match = sql.match(/DELETE FROM (\w+)/);
      const table = match?.[1];
      const rowCount = table !== undefined ? (deletePerTable[table] ?? 0) : 0;
      return Promise.resolve({ rows: [], rowCount });
    }),
    release: vi.fn(),
  };
  return {
    connect: vi.fn(() => Promise.resolve(client)),
  } as unknown as Pool;
}

describe("TenantDeletionService", () => {
  it("deletes across every tenant-scoped table in one transaction", async () => {
    const pool = fakePool({
      raw_artifacts: 3,
      ledger_payment_intents: 5,
      wiki_pages: 7,
      policy_decisions: 4,
      agents: 2,
    });
    const audit = new InMemoryAuditEmitter();
    const svc = new TenantDeletionService({ privilegedPool: pool, audit });

    const result = await svc.deleteTenant({ tenantId: TENANT, actor: USER }, TENANT);

    expect(result.tenantId).toBe(TENANT);
    expect(result.deletedRows.raw_artifacts).toBe(3);
    expect(result.deletedRows.ledger_payment_intents).toBe(5);
    expect(result.totalRows).toBe(3 + 5 + 7 + 4 + 2);
  });

  it("preserves audit_events and audit_anchors (no DELETE issued)", async () => {
    const pool = fakePool({});
    const audit = new InMemoryAuditEmitter();
    const svc = new TenantDeletionService({ privilegedPool: pool, audit });
    await svc.deleteTenant({ tenantId: TENANT, actor: USER }, TENANT);

    // Inspect every DELETE call the service issued.
    const client = await pool.connect();
    const calls = vi.mocked(client.query).mock.calls.map((c) => c[0] as string);
    const deletes = calls.filter((c) => c.startsWith("DELETE FROM "));
    expect(deletes.some((d) => d.includes("audit_events"))).toBe(false);
    expect(deletes.some((d) => d.includes("audit_anchors"))).toBe(false);
  });

  it("emits a tenant.deleted audit event with the per-table breakdown", async () => {
    const pool = fakePool({ raw_artifacts: 2, ledger_accounts: 3 });
    const audit = new InMemoryAuditEmitter();
    const svc = new TenantDeletionService({ privilegedPool: pool, audit });
    await svc.deleteTenant({ tenantId: TENANT, actor: USER }, TENANT);

    const events = audit.events;
    expect(events).toHaveLength(1);
    const evt = events[0]!;
    expect(evt.action).toBe("tenant.deleted");
    expect(evt.tenantId).toBe(TENANT);
    const outputs = evt.outputs as {
      total_rows_deleted: number;
      per_table_counts: Record<string, number>;
      preserved: string[];
    };
    expect(outputs.total_rows_deleted).toBe(5);
    expect(outputs.per_table_counts.raw_artifacts).toBe(2);
    expect(outputs.per_table_counts.ledger_accounts).toBe(3);
    expect(outputs.preserved).toContain("audit_events");
    expect(outputs.preserved).toContain("audit_anchors");
  });

  it("rolls back on a DELETE failure and does not emit the tombstone event", async () => {
    const client = {
      query: vi.fn((sql: string) => {
        if (sql.includes("ledger_payment_intents")) {
          return Promise.reject(new Error("constraint violation"));
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(() => Promise.resolve(client)) } as unknown as Pool;
    const audit = new InMemoryAuditEmitter();
    const svc = new TenantDeletionService({ privilegedPool: pool, audit });

    await expect(svc.deleteTenant({ tenantId: TENANT, actor: USER }, TENANT)).rejects.toThrow(
      "constraint violation",
    );

    // Last call after the failure must be ROLLBACK, not COMMIT.
    const sqlCalls = client.query.mock.calls.map((c) => c[0] as string);
    expect(sqlCalls).toContain("ROLLBACK");
    expect(sqlCalls).not.toContain("COMMIT");
    // No audit emit on rollback.
    expect(audit.events).toHaveLength(0);
  });
});
