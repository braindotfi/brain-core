import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { MockMetrics, newTenantId } from "@brain/shared";
import type { AgentRunResult } from "@brain/agent-router";
import {
  runReconciliationUnreconciledScanCycle,
  type ReconciliationUnreconciledRow,
} from "./reconciliation-unreconciled-scanner.js";

const tenantA = newTenantId();
const tenantB = newTenantId();

describe("runReconciliationUnreconciledScanCycle", () => {
  it("runs one reconciliation proposal per unreconciled transaction and respects cooldown", async () => {
    const tx = transaction({ tenant_id: tenantA, transaction_id: "tx_1", counterparty_id: "cp_1" });
    const scanPool = scanPoolWith([tx]);
    const appPool = cooldownPool();
    const run = vi.fn(
      async (_ctx: unknown, _input: unknown): Promise<AgentRunResult> => ({
        status: "proposal_created",
        routing_decision_id: "agrd_1",
        run_id: "agnr_1",
        selected_agent_id: "reconciliation",
        action: "propose_match",
        shadow_mode: false,
        proposed: { id: "prop_1", status: "pending", policy_decision_id: "pd_1" },
        reason: {},
      }),
    );
    const metrics = new MockMetrics();

    await runReconciliationUnreconciledScanCycle(
      { scanPool, appPool, runService: { run }, metrics },
      { now: new Date("2026-07-19T00:00:00.000Z"), cooldownMs: 86_400_000 },
    );
    await runReconciliationUnreconciledScanCycle(
      { scanPool, appPool, runService: { run }, metrics },
      { now: new Date("2026-07-19T01:00:00.000Z"), cooldownMs: 86_400_000 },
    );

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: tenantA, actor: "reconciliation_unreconciled_scanner" }),
      expect.objectContaining({
        tenant_id: tenantA,
        event: "reconciliation.candidate_found",
        context: expect.objectContaining({
          transaction_id: "tx_1",
          amount: "900.00",
          currency: "USD",
          counterparty_id: "cp_1",
          candidates: expect.arrayContaining([expect.objectContaining({ id: "inv_1" })]),
        }),
      }),
    );
    expect(metrics.calls.some((call) => call.name === "brain.reconciliation.scan.count")).toBe(
      true,
    );
    expect(
      metrics.calls.some((call) => call.name === "brain.reconciliation.scan.last_success_unixtime"),
    ).toBe(true);
  });

  it("uses the transaction.unreconciled event when no candidate exists", async () => {
    const tx = transaction({ tenant_id: tenantA, transaction_id: "tx_empty", candidates: [] });
    const run = vi.fn(
      async (_ctx: unknown, _input: unknown): Promise<AgentRunResult> => ({
        status: "proposal_created",
        routing_decision_id: "agrd_1",
        run_id: "agnr_1",
        selected_agent_id: "reconciliation",
        action: "propose_match",
        shadow_mode: false,
        reason: {},
      }),
    );

    await runReconciliationUnreconciledScanCycle(
      { scanPool: scanPoolWith([tx]), appPool: cooldownPool(), runService: { run } },
      { now: new Date("2026-07-19T00:00:00.000Z"), cooldownMs: 86_400_000 },
    );

    expect(run.mock.calls[0]?.[1]).toMatchObject({ event: "transaction.unreconciled" });
  });

  it("reports the true eligible backlog when the global cap is hit", async () => {
    const rows = [
      transaction({ tenant_id: tenantA, transaction_id: "tx_1" }),
      transaction({ tenant_id: tenantA, transaction_id: "tx_2" }),
      transaction({ tenant_id: tenantB, transaction_id: "tx_3" }),
    ];
    const scanPool = scanPoolWith(rows, { eligibleCount: 5, fairCount: 3 });
    const metrics = new MockMetrics();
    const log = { warn: vi.fn(), error: vi.fn() };
    const run = vi.fn(
      async (): Promise<AgentRunResult> => ({
        status: "proposal_created",
        routing_decision_id: "agrd_1",
        run_id: "agnr_1",
        selected_agent_id: "reconciliation",
        action: "propose_match",
        shadow_mode: false,
        proposed: { id: "prop_1", status: "pending", policy_decision_id: "pd_1" },
        reason: {},
      }),
    );

    await runReconciliationUnreconciledScanCycle(
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
      "reconciliation unreconciled scanner hit batch cap",
    );
    expect(metrics.calls).toContainEqual({
      kind: "increment",
      name: "brain.reconciliation.scan.dropped.count",
      value: 3,
      tags: { reason: "batch_cap" },
    });
  });
});

function transaction(
  override: Partial<ReconciliationUnreconciledRow>,
): ReconciliationUnreconciledRow {
  return {
    tenant_id: tenantA,
    transaction_id: "tx_1",
    account_id: "acct_1",
    amount: "900.00",
    currency: "USD",
    direction: "inflow",
    transaction_date: "2026-07-18T00:00:00.000Z",
    counterparty_id: "cp_1",
    counterparty_name: "Acme",
    description: "Acme payment",
    candidates: [
      {
        kind: "invoice",
        id: "inv_1",
        amount: "900.00",
        currency: "USD",
        date: "2026-07-18T00:00:00.000Z",
        counterparty_id: "cp_1",
        counterparty_name: "Acme",
        label: "INV-1",
        status: "sent",
      },
    ],
    ...override,
  };
}

function scanPoolWith(
  rows: ReconciliationUnreconciledRow[],
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
