import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { MockMetrics, newTenantId } from "@brain/shared";
import type { AgentRunResult } from "@brain/agent-router";
import {
  runCollectionsOverdueScanCycle,
  type CollectionsOverdueReceivableRow,
} from "./collections-overdue-scanner.js";

const tenantA = newTenantId();
const tenantB = newTenantId();

describe("runCollectionsOverdueScanCycle", () => {
  it("runs one collections proposal per overdue invoice and respects cooldown", async () => {
    const invoice = receivable({ tenant_id: tenantA, id: "inv_1", counterparty_id: "cp_1" });
    const scanPool = scanPoolWith([invoice]);
    const appPool = cooldownPool();
    const run = vi.fn(
      async (): Promise<AgentRunResult> => ({
        status: "proposal_created",
        routing_decision_id: "agrd_1",
        run_id: "agnr_1",
        selected_agent_id: "collections",
        action: "draft_followup",
        shadow_mode: false,
        proposed: { id: "prop_1", status: "pending", policy_decision_id: "pd_1" },
        reason: {},
      }),
    );
    const metrics = new MockMetrics();

    await runCollectionsOverdueScanCycle(
      { scanPool, appPool, runService: { run }, metrics },
      { now: new Date("2026-07-19T00:00:00.000Z"), cooldownMs: 86_400_000 },
    );
    await runCollectionsOverdueScanCycle(
      { scanPool, appPool, runService: { run }, metrics },
      { now: new Date("2026-07-19T01:00:00.000Z"), cooldownMs: 86_400_000 },
    );

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: tenantA, actor: "collections_overdue_scanner" }),
      expect.objectContaining({
        tenant_id: tenantA,
        event: "receivable.aging_threshold_crossed",
        context: expect.objectContaining({
          invoice_id: "inv_1",
          counterparty_id: "cp_1",
          amount: "900.00",
          currency: "USD",
          days_overdue: 18,
          aging_tier: "15_29",
        }),
      }),
    );
    expect(metrics.calls.some((call) => call.name === "brain.collections.scan.count")).toBe(true);
    expect(
      metrics.calls.some((call) => call.name === "brain.collections.scan.last_success_unixtime"),
    ).toBe(true);
  });

  it("keeps tenants isolated and lets missing evidence hold the run", async () => {
    const scanPool = scanPoolWith([
      receivable({ tenant_id: tenantA, id: "inv_a", counterparty_id: "cp_a" }),
      receivable({ tenant_id: tenantB, id: "inv_b", counterparty_id: "cp_b" }),
    ]);
    const appPool = cooldownPool();
    const run = vi.fn(
      async (ctx: { tenantId: string }): Promise<AgentRunResult> => ({
        status: ctx.tenantId === tenantA ? "proposal_created" : "missing_evidence",
        routing_decision_id: `agrd_${ctx.tenantId}`,
        run_id: `agnr_${ctx.tenantId}`,
        selected_agent_id: "collections",
        action: "draft_followup",
        shadow_mode: false,
        reason: ctx.tenantId === tenantA ? {} : { critical_missing: true },
      }),
    );

    await runCollectionsOverdueScanCycle(
      { scanPool, appPool, runService: { run } },
      { now: new Date("2026-07-19T00:00:00.000Z"), cooldownMs: 86_400_000 },
    );

    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls.map(([ctx]) => ctx.tenantId)).toEqual([tenantA, tenantB]);
  });

  it("reports the true eligible backlog when the global cap is hit", async () => {
    const rows = [
      receivable({ tenant_id: tenantA, id: "inv_1", counterparty_id: "cp_1" }),
      receivable({ tenant_id: tenantA, id: "inv_2", counterparty_id: "cp_1" }),
      receivable({ tenant_id: tenantB, id: "inv_3", counterparty_id: "cp_2" }),
    ];
    const scanPool = scanPoolWith(rows, { eligibleCount: 5, fairCount: 3 });
    const metrics = new MockMetrics();
    const log = { warn: vi.fn(), error: vi.fn() };
    const run = vi.fn(
      async (): Promise<AgentRunResult> => ({
        status: "proposal_created",
        routing_decision_id: "agrd_1",
        run_id: "agnr_1",
        selected_agent_id: "collections",
        action: "draft_followup",
        shadow_mode: false,
        proposed: { id: "prop_1", status: "pending", policy_decision_id: "pd_1" },
        reason: {},
      }),
    );

    await runCollectionsOverdueScanCycle(
      { scanPool, appPool: cooldownPool(), runService: { run }, metrics, log },
      {
        now: new Date("2026-07-19T00:00:00.000Z"),
        batchSize: 2,
        perTenantBatchSize: 2,
        cooldownMs: 86_400_000,
      },
    );

    expect(run).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        batchSize: 2,
        perTenantBatchSize: 2,
        total_eligible: 5,
        total_fair: 3,
        omitted_count: 3,
      }),
      "collections overdue scanner hit batch cap",
    );
    expect(metrics.calls).toContainEqual({
      kind: "increment",
      name: "brain.collections.scan.dropped.count",
      value: 3,
      tags: { reason: "batch_cap" },
    });
  });
});

function receivable(
  override: Partial<CollectionsOverdueReceivableRow>,
): CollectionsOverdueReceivableRow {
  return {
    tenant_id: tenantA,
    id: "inv_1",
    invoice_number: "INV-1",
    counterparty_id: "cp_1",
    counterparty_name: "Acme",
    amount: "900.00",
    currency: "USD",
    due_date: "2026-07-01T00:00:00.000Z",
    days_overdue: 18,
    aging_tier: "15_29",
    ...override,
  };
}

function scanPoolWith(
  rows: CollectionsOverdueReceivableRow[],
  counts: { eligibleCount?: number; fairCount?: number } = {},
): Pool {
  const enriched = rows.map((row) => ({
    ...row,
    eligible_count: counts.eligibleCount ?? rows.length,
    fair_count: counts.fairCount ?? rows.length,
  }));
  return {
    query: vi.fn(async () => ({ rows: enriched, rowCount: enriched.length })),
  } as unknown as Pool;
}

function cooldownPool(): Pool {
  const keys = new Set<string>();
  const client = {
    query: vi.fn(async (text: string, values: unknown[] = []) => {
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (text.startsWith("SELECT set_config")) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("INSERT INTO agent_trigger_cooldowns")) {
        const key = String(values[0]);
        if (keys.has(key)) return { rows: [], rowCount: 0 };
        keys.add(key);
        return { rows: [{ trigger_key: key }], rowCount: 1 };
      }
      if (text.includes("UPDATE agent_trigger_cooldowns")) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
  return { connect: async () => client } as unknown as Pool;
}
