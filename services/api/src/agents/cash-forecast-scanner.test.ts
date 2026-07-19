import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { MockMetrics, newTenantId } from "@brain/shared";
import type { AgentRunResult } from "@brain/agent-router";
import { runCashForecastScanCycle, type CashForecastPositionRow } from "./cash-forecast-scanner.js";

const tenantA = newTenantId();
const tenantB = newTenantId();

describe("runCashForecastScanCycle", () => {
  it("runs one forecast proposal per position and respects cooldown", async () => {
    const row = position({ tenant_id: tenantA, balance_id: "bal_1" });
    const scanPool = scanPoolWith([row]);
    const appPool = cooldownPool();
    const run = vi.fn(
      async (_ctx: unknown, _input: unknown): Promise<AgentRunResult> => ({
        status: "proposal_created",
        routing_decision_id: "agrd_1",
        run_id: "agnr_1",
        selected_agent_id: "cash_forecast",
        action: "generate_forecast",
        shadow_mode: false,
        proposed: { id: "prop_1", status: "pending", policy_decision_id: "pd_1" },
        reason: {},
      }),
    );
    const metrics = new MockMetrics();

    await runCashForecastScanCycle(
      { scanPool, appPool, runService: { run }, metrics },
      { now: new Date("2026-07-19T00:00:00.000Z"), cooldownMs: 86_400_000 },
    );
    await runCashForecastScanCycle(
      { scanPool, appPool, runService: { run }, metrics },
      { now: new Date("2026-07-19T01:00:00.000Z"), cooldownMs: 86_400_000 },
    );

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: tenantA, actor: "cash_forecast_scanner" }),
      expect.objectContaining({
        tenant_id: tenantA,
        event: "cashflow.material_change",
        context: expect.objectContaining({
          balance_id: "bal_1",
          current_balance: "1000.00",
          currency: "USD",
          receivables: expect.arrayContaining([expect.objectContaining({ invoice_id: "inv_1" })]),
          payables: expect.arrayContaining([expect.objectContaining({ obligation_id: "obl_1" })]),
        }),
      }),
    );
    expect(metrics.calls.some((call) => call.name === "brain.cash_forecast.scan.count")).toBe(true);
    expect(
      metrics.calls.some((call) => call.name === "brain.cash_forecast.scan.last_success_unixtime"),
    ).toBe(true);
  });

  it("uses large_payable.created when a payable crosses the large payable threshold", async () => {
    const row = position({ max_payable_amount: "30000.00" });
    const run = vi.fn(
      async (_ctx: unknown, _input: unknown): Promise<AgentRunResult> => ({
        status: "proposal_created",
        routing_decision_id: "agrd_1",
        run_id: "agnr_1",
        selected_agent_id: "cash_forecast",
        action: "alert_shortfall",
        shadow_mode: false,
        reason: {},
      }),
    );

    await runCashForecastScanCycle(
      { scanPool: scanPoolWith([row]), appPool: cooldownPool(), runService: { run } },
      { now: new Date("2026-07-19T00:00:00.000Z"), largePayableAmount: 25000 },
    );

    expect(run.mock.calls[0]?.[1]).toMatchObject({ event: "large_payable.created" });
  });

  it("uses forecast.requested when no material change is detected", async () => {
    const row = position({
      current_balance: "1000000.00",
      total_flow_amount: "10.00",
      max_payable_amount: "0.00",
    });
    const run = vi.fn(
      async (_ctx: unknown, _input: unknown): Promise<AgentRunResult> => ({
        status: "proposal_created",
        routing_decision_id: "agrd_1",
        run_id: "agnr_1",
        selected_agent_id: "cash_forecast",
        action: "generate_forecast",
        shadow_mode: false,
        reason: {},
      }),
    );

    await runCashForecastScanCycle(
      { scanPool: scanPoolWith([row]), appPool: cooldownPool(), runService: { run } },
      { now: new Date("2026-07-19T00:00:00.000Z") },
    );

    expect(run.mock.calls[0]?.[1]).toMatchObject({ event: "forecast.requested" });
  });

  it("reports the true eligible backlog when the global cap is hit", async () => {
    const rows = [
      position({ tenant_id: tenantA, balance_id: "bal_1" }),
      position({ tenant_id: tenantA, balance_id: "bal_2", currency: "EUR" }),
      position({ tenant_id: tenantB, balance_id: "bal_3" }),
    ];
    const scanPool = scanPoolWith(rows, { eligibleCount: 5, fairCount: 3 });
    const metrics = new MockMetrics();
    const log = { warn: vi.fn(), error: vi.fn() };
    const run = vi.fn(
      async (): Promise<AgentRunResult> => ({
        status: "proposal_created",
        routing_decision_id: "agrd_1",
        run_id: "agnr_1",
        selected_agent_id: "cash_forecast",
        action: "generate_forecast",
        shadow_mode: false,
        proposed: { id: "prop_1", status: "pending", policy_decision_id: "pd_1" },
        reason: {},
      }),
    );

    await runCashForecastScanCycle(
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
      "cash forecast scanner hit batch cap",
    );
    expect(metrics.calls).toContainEqual({
      kind: "increment",
      name: "brain.cash_forecast.scan.dropped.count",
      value: 3,
      tags: { reason: "batch_cap" },
    });
  });
});

function position(override: Partial<CashForecastPositionRow>): CashForecastPositionRow {
  return {
    tenant_id: tenantA,
    currency: "USD",
    balance_id: "bal_1",
    current_balance: "1000.00",
    as_of: "2026-07-18T00:00:00.000Z",
    receivables: [
      {
        invoice_id: "inv_1",
        amount: "500.00",
        currency: "USD",
        due_date: "2026-08-01T00:00:00.000Z",
        counterparty_id: "cp_1",
        counterparty_name: "Acme",
      },
    ],
    payables: [
      {
        obligation_id: "obl_1",
        amount: "300.00",
        currency: "USD",
        due_date: "2026-08-15T00:00:00.000Z",
        counterparty_id: "cp_2",
        counterparty_name: "Vendor",
      },
    ],
    total_flow_amount: "800.00",
    max_payable_amount: "300.00",
    ...override,
  };
}

function scanPoolWith(
  rows: CashForecastPositionRow[],
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
