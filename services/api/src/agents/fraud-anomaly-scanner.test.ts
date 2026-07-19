import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { MockMetrics, newTenantId } from "@brain/shared";
import type { AgentRunResult } from "@brain/agent-router";
import {
  runFraudAnomalyScanCycle,
  type FraudAnomalyTransactionRow,
} from "./fraud-anomaly-scanner.js";

const tenantA = newTenantId();
const tenantB = newTenantId();

describe("runFraudAnomalyScanCycle", () => {
  it("runs one fraud anomaly proposal per row and respects cooldown", async () => {
    const row = transaction({ tenant_id: tenantA, transaction_id: "tx_1" });
    const scanPool = scanPoolWith([row]);
    const appPool = cooldownPool();
    const run = vi.fn(
      async (_ctx: unknown, _input: unknown): Promise<AgentRunResult> => ({
        status: "proposal_created",
        routing_decision_id: "agrd_1",
        run_id: "agnr_1",
        selected_agent_id: "fraud_anomaly",
        action: "flag_transaction",
        shadow_mode: false,
        proposed: { id: "prop_1", status: "pending", policy_decision_id: "pd_1" },
        reason: {},
      }),
    );
    const metrics = new MockMetrics();

    await runFraudAnomalyScanCycle(
      { scanPool, appPool, runService: { run }, metrics },
      { now: new Date("2026-07-19T00:00:00.000Z"), cooldownMs: 86_400_000 },
    );
    await runFraudAnomalyScanCycle(
      { scanPool, appPool, runService: { run }, metrics },
      { now: new Date("2026-07-19T01:00:00.000Z"), cooldownMs: 86_400_000 },
    );

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: tenantA, actor: "fraud_anomaly_scanner" }),
      expect.objectContaining({
        tenant_id: tenantA,
        event: "duplicate_charge.detected",
        context: expect.objectContaining({
          transaction_id: "tx_1",
          account_id: "acct_1",
          amount: "1000.00",
          duplicate_transaction_ids: ["tx_prior"],
        }),
      }),
    );
    expect(metrics.calls.some((call) => call.name === "brain.fraud_anomaly.scan.count")).toBe(true);
    expect(
      metrics.calls.some((call) => call.name === "brain.fraud_anomaly.scan.last_success_unixtime"),
    ).toBe(true);
  });

  it("uses merchant.risk_detected when the row is marked as merchant risk", async () => {
    const row = transaction({
      event_hint: "merchant.risk_detected",
      duplicate_count_7d: "0",
      merchant_risk_score: "0.85",
    });
    const run = vi.fn(
      async (_ctx: unknown, _input: unknown): Promise<AgentRunResult> => ({
        status: "proposal_created",
        routing_decision_id: "agrd_1",
        run_id: "agnr_1",
        selected_agent_id: "fraud_anomaly",
        action: "flag_transaction",
        shadow_mode: false,
        reason: {},
      }),
    );

    await runFraudAnomalyScanCycle(
      { scanPool: scanPoolWith([row]), appPool: cooldownPool(), runService: { run } },
      { now: new Date("2026-07-19T00:00:00.000Z") },
    );

    expect(run.mock.calls[0]?.[1]).toMatchObject({ event: "merchant.risk_detected" });
  });

  it("falls back to transaction.unusual for an unknown event hint", async () => {
    const row = transaction({ event_hint: "unexpected", duplicate_count_7d: "0" });
    const run = vi.fn(
      async (_ctx: unknown, _input: unknown): Promise<AgentRunResult> => ({
        status: "proposal_created",
        routing_decision_id: "agrd_1",
        run_id: "agnr_1",
        selected_agent_id: "fraud_anomaly",
        action: "flag_transaction",
        shadow_mode: false,
        reason: {},
      }),
    );

    await runFraudAnomalyScanCycle(
      { scanPool: scanPoolWith([row]), appPool: cooldownPool(), runService: { run } },
      { now: new Date("2026-07-19T00:00:00.000Z") },
    );

    expect(run.mock.calls[0]?.[1]).toMatchObject({ event: "transaction.unusual" });
  });

  it("reports the true eligible backlog when the global cap is hit", async () => {
    const rows = [
      transaction({ tenant_id: tenantA, transaction_id: "tx_1" }),
      transaction({ tenant_id: tenantA, transaction_id: "tx_2" }),
      transaction({ tenant_id: tenantB, transaction_id: "tx_3" }),
    ];
    const scanPool = scanPoolWith(rows, { eligibleCount: "6", fairCount: "3" });
    const metrics = new MockMetrics();
    const log = { warn: vi.fn(), error: vi.fn() };
    const run = vi.fn(
      async (): Promise<AgentRunResult> => ({
        status: "proposal_created",
        routing_decision_id: "agrd_1",
        run_id: "agnr_1",
        selected_agent_id: "fraud_anomaly",
        action: "flag_transaction",
        shadow_mode: false,
        proposed: { id: "prop_1", status: "pending", policy_decision_id: "pd_1" },
        reason: {},
      }),
    );

    await runFraudAnomalyScanCycle(
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
        total_eligible: 6,
        total_fair: 3,
        omitted_count: 4,
      }),
      "fraud anomaly scanner hit batch cap",
    );
    expect(metrics.calls).toContainEqual({
      kind: "increment",
      name: "brain.fraud_anomaly.scan.dropped.count",
      value: 4,
      tags: { reason: "batch_cap" },
    });
  });

  it("handles an empty eligible set", async () => {
    const run = vi.fn();
    const metrics = new MockMetrics();

    await runFraudAnomalyScanCycle(
      { scanPool: scanPoolWith([]), appPool: cooldownPool(), runService: { run }, metrics },
      { now: new Date("2026-07-19T00:00:00.000Z") },
    );

    expect(run).not.toHaveBeenCalled();
    expect(metrics.calls).toHaveLength(0);
  });
});

function transaction(override: Partial<FraudAnomalyTransactionRow>): FraudAnomalyTransactionRow {
  return {
    tenant_id: tenantA,
    transaction_id: "tx_1",
    account_id: "acct_1",
    amount: "1000.00",
    currency: "USD",
    direction: "outflow",
    transaction_date: "2026-07-18T00:00:00.000Z",
    counterparty_id: "cp_1",
    counterparty_name: "Merchant",
    description: "merchant charge",
    history_count: "12",
    account_mean_amount: "100.00",
    account_stddev_amount: "10.00",
    counterparty_mean_amount: "100.00",
    counterparty_stddev_amount: "10.00",
    duplicate_count_7d: "1",
    duplicate_transaction_ids: ["tx_prior"],
    velocity_count_24h: "1",
    account_daily_count_avg: "1",
    merchant_risk_score: null,
    anomaly_score: "0.95",
    event_hint: "duplicate_charge.detected",
    ...override,
  };
}

function scanPoolWith(
  rows: FraudAnomalyTransactionRow[],
  counts: { eligibleCount?: number | string; fairCount?: number | string } = {},
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
