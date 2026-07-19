import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { MockMetrics, newTenantId } from "@brain/shared";
import type { AgentRunResult } from "@brain/agent-router";
import { runDisputeScanCycle, type DisputeCandidateRow } from "./dispute-scanner.js";
import {
  runRevenueIntelScanCycle,
  type RevenueIntelCandidateRow,
} from "./revenue-intel-scanner.js";
import { runSubscriptionScanCycle, type SubscriptionCandidateRow } from "./subscription-scanner.js";

const tenantA = newTenantId();
const tenantB = newTenantId();

describe("Wave C scanner cycles", () => {
  it("runs dispute proposals once per cooldown window and routes chargebacks", async () => {
    const row = dispute({ tenant_id: tenantA, dispute_id: "dsp_1" });
    const run = vi.fn(async (): Promise<AgentRunResult> => agentResult("dispute"));
    const metrics = new MockMetrics();

    await runDisputeScanCycle(
      {
        scanPool: scanPoolWith([row]),
        appPool: cooldownPool(),
        runService: { run },
        metrics,
      },
      { now: new Date("2026-07-19T00:00:00.000Z"), cooldownMs: 86_400_000 },
    );

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: tenantA, actor: "dispute_scanner" }),
      expect.objectContaining({
        tenant_id: tenantA,
        event: "chargeback.received",
        context: expect.objectContaining({
          dispute_id: "dsp_1",
          transaction_id: "tx_1",
          dispute_confidence: "0.9",
          evidence_completeness: "0.9",
        }),
      }),
    );
    expect(metrics.calls.some((call) => call.name === "brain.dispute.scan.count")).toBe(true);
  });

  it("reports true dispute backlog and keeps cooldown exclusion in the SELECT", async () => {
    const query = vi.fn(async (text: string, _values?: unknown[]) => ({
      rows: [
        enrich(dispute({ tenant_id: tenantA, dispute_id: "dsp_1" }), 5, 3),
        enrich(dispute({ tenant_id: tenantB, dispute_id: "dsp_2" }), 5, 3),
        enrich(dispute({ tenant_id: tenantB, dispute_id: "dsp_3" }), 5, 3),
      ],
      rowCount: 3,
      text,
    }));
    const metrics = new MockMetrics();
    const log = { warn: vi.fn(), error: vi.fn() };

    await runDisputeScanCycle(
      {
        scanPool: { query } as unknown as Pool,
        appPool: cooldownPool(),
        runService: { run: vi.fn(async () => agentResult("dispute")) },
        metrics,
        log,
      },
      { now: new Date("2026-07-19T00:00:00.000Z"), batchSize: 2, perTenantBatchSize: 2 },
    );

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("row_number() OVER (PARTITION BY c.tenant_id");
    expect(sql).toContain("WHERE cd.id IS NULL OR cd.last_enqueued_at < $1::timestamptz");
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ total_eligible: 5, total_fair: 3, omitted_count: 3 }),
      "dispute scanner hit batch cap",
    );
    expect(metrics.calls).toContainEqual({
      kind: "increment",
      name: "brain.dispute.scan.dropped.count",
      tags: { reason: "batch_cap" },
      value: 3,
    });
  });

  it("runs revenue intel proposals with notify-only context fields", async () => {
    const run = vi.fn(async (): Promise<AgentRunResult> => agentResult("revenue_intel"));

    await runRevenueIntelScanCycle(
      {
        scanPool: scanPoolWith([revenue({ tenant_id: tenantA, counterparty_id: "cp_1" })]),
        appPool: cooldownPool(),
        runService: { run },
      },
      { now: new Date("2026-07-19T00:00:00.000Z") },
    );

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: tenantA, actor: "revenue_intel_scanner" }),
      expect.objectContaining({
        tenant_id: tenantA,
        event: "customer.payment_behavior_changed",
        context: expect.objectContaining({
          current_period_revenue: "1200.00",
          prior_period_revenue: "1000.00",
          current_dso: "35",
          prior_dso: "20",
        }),
      }),
    );
  });

  it("runs subscription proposals and pins cooldown SELECT shape", async () => {
    const query = vi.fn(async (text: string, _values?: unknown[]) => ({
      rows: [enrich(subscription({ tenant_id: tenantA, transaction_id: "tx_sub_1" }), 1, 1)],
      rowCount: 1,
      text,
    }));
    const run = vi.fn(async (): Promise<AgentRunResult> => agentResult("subscription"));

    await runSubscriptionScanCycle(
      {
        scanPool: { query } as unknown as Pool,
        appPool: cooldownPool(),
        runService: { run },
      },
      { now: new Date("2026-07-19T00:00:00.000Z") },
    );

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("row_number() OVER (PARTITION BY c.tenant_id");
    expect(sql).toContain("WHERE cd.id IS NULL OR cd.last_enqueued_at < $1::timestamptz");
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: tenantA, actor: "subscription_scanner" }),
      expect.objectContaining({
        event: "subscription.price_changed",
        context: expect.objectContaining({
          transaction_id: "tx_sub_1",
          history: expect.arrayContaining([
            expect.objectContaining({ transaction_id: "tx_sub_1" }),
          ]),
        }),
      }),
    );
  });
});

function dispute(override: Partial<DisputeCandidateRow>): DisputeCandidateRow {
  return {
    tenant_id: tenantA,
    dispute_id: "dsp_1",
    transaction_id: "tx_1",
    counterparty_id: "cp_1",
    amount: "750.00",
    currency: "USD",
    deadline: "2026-07-25",
    dispute_age_days: "7",
    evidence_completeness: "0.9",
    event_hint: "chargeback.received",
    ...override,
  };
}

function revenue(override: Partial<RevenueIntelCandidateRow>): RevenueIntelCandidateRow {
  return {
    tenant_id: tenantA,
    counterparty_id: "cp_1",
    invoice_id: "inv_1",
    transaction_id: "tx_1",
    currency: "USD",
    current_period_revenue: "1200.00",
    prior_period_revenue: "1000.00",
    current_dso: "35",
    prior_dso: "20",
    event_hint: "customer.payment_behavior_changed",
    detected_at: "2026-07-18T00:00:00.000Z",
    ...override,
  };
}

function subscription(override: Partial<SubscriptionCandidateRow>): SubscriptionCandidateRow {
  return {
    tenant_id: tenantA,
    transaction_id: "tx_sub_1",
    counterparty_id: "cp_1",
    amount: "130.00",
    currency: "USD",
    transaction_date: "2026-07-18",
    history: [
      { transaction_id: "tx_sub_0", amount: "100.00", transaction_date: "2026-05-18" },
      { transaction_id: "tx_sub_1a", amount: "100.00", transaction_date: "2026-06-18" },
      { transaction_id: "tx_sub_1", amount: "130.00", transaction_date: "2026-07-18" },
    ],
    event_hint: "subscription.price_changed",
    ...override,
  };
}

function enrich<T extends object>(
  row: T,
  eligibleCount: number | string,
  fairCount: number | string,
): T {
  return { ...row, eligible_count: eligibleCount, fair_count: fairCount } as T;
}

function scanPoolWith<T extends object>(rows: readonly T[]): Pool {
  return {
    query: vi.fn(async () => ({
      rows: rows.map((row) => enrich(row, rows.length, rows.length)),
      rowCount: rows.length,
    })),
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

function agentResult(agentKey: string): AgentRunResult {
  return {
    status: "proposal_created",
    routing_decision_id: "agrd_1",
    run_id: "agnr_1",
    selected_agent_id: agentKey,
    action: "notify",
    shadow_mode: false,
    proposed: { id: "prop_1", status: "pending", policy_decision_id: "pd_prop_1" },
    reason: {},
  };
}
