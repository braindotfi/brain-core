import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { MockMetrics, newTenantId } from "@brain/shared";
import type { AgentRunResult } from "@brain/agent-router";
import { runTreasuryScanCycle, type TreasuryBalanceRow } from "./treasury-scanner.js";

const tenantA = newTenantId();
const tenantB = newTenantId();

describe("runTreasuryScanCycle", () => {
  it("runs one treasury advisory per balance and respects cooldown", async () => {
    const row = balance({ tenant_id: tenantA, balance_id: "bal_1" });
    const scanPool = scanPoolWith([row]);
    const appPool = cooldownPool();
    const run = vi.fn(
      async (): Promise<AgentRunResult> => result("treasury", "recommend_cash_sweep"),
    );
    const metrics = new MockMetrics();

    await runTreasuryScanCycle(
      { scanPool, appPool, runService: { run }, metrics },
      { now: new Date("2026-07-19T00:00:00.000Z"), cooldownMs: 86_400_000 },
    );
    await runTreasuryScanCycle(
      { scanPool, appPool, runService: { run }, metrics },
      { now: new Date("2026-07-19T01:00:00.000Z"), cooldownMs: 86_400_000 },
    );

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: tenantA, actor: "treasury_scanner" }),
      expect.objectContaining({
        tenant_id: tenantA,
        event: "cash.balance_high",
        context: expect.objectContaining({
          balance_id: "bal_1",
          account_id: "acct_1",
          source_account_id: "acct_1",
          current_balance: "120000.00",
          currency: "USD",
        }),
      }),
    );
    expect(metrics.calls.some((call) => call.name === "brain.treasury.scan.count")).toBe(true);
  });

  it("uses cash.balance_low for low balance rows", async () => {
    const row = balance({ event_hint: "cash.balance_low", current_balance: "10000.00" });
    const run = vi.fn(async (): Promise<AgentRunResult> => result("treasury", "alert_low_balance"));

    await runTreasuryScanCycle(
      { scanPool: scanPoolWith([row]), appPool: cooldownPool(), runService: { run } },
      { now: new Date("2026-07-19T00:00:00.000Z") },
    );

    expect(run).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ event: "cash.balance_low" }),
    );
  });

  it("reports the true eligible backlog when the global cap is hit", async () => {
    const rows = [
      balance({ tenant_id: tenantA, balance_id: "bal_1" }),
      balance({ tenant_id: tenantA, balance_id: "bal_2", account_id: "acct_2" }),
      balance({ tenant_id: tenantB, balance_id: "bal_3", account_id: "acct_3" }),
    ];
    const scanPool = scanPoolWith(rows, { eligibleCount: 5, fairCount: 3 });
    const metrics = new MockMetrics();
    const log = { warn: vi.fn(), error: vi.fn() };
    const run = vi.fn(
      async (): Promise<AgentRunResult> => result("treasury", "recommend_cash_sweep"),
    );

    await runTreasuryScanCycle(
      { scanPool, appPool: cooldownPool(), runService: { run }, metrics, log },
      { now: new Date("2026-07-19T00:00:00.000Z"), batchSize: 2, perTenantBatchSize: 2 },
    );

    expect(run).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ total_eligible: 5, total_fair: 3, omitted_count: 3 }),
      "treasury scanner hit batch cap",
    );
    expect(metrics.calls).toContainEqual({
      kind: "increment",
      name: "brain.treasury.scan.dropped.count",
      value: 3,
      tags: { reason: "batch_cap" },
    });
  });
});

function balance(override: Partial<TreasuryBalanceRow>): TreasuryBalanceRow {
  return {
    tenant_id: tenantA,
    balance_id: "bal_1",
    account_id: "acct_1",
    current_balance: "120000.00",
    currency: "USD",
    as_of: "2026-07-18T00:00:00.000Z",
    event_hint: "cash.balance_high",
    ...override,
  };
}

function scanPoolWith(
  rows: TreasuryBalanceRow[],
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
  return { connect: vi.fn(async () => client) } as unknown as Pool;
}

function result(agent: string, action: string): AgentRunResult {
  return {
    status: "proposal_created",
    routing_decision_id: "agrd_1",
    run_id: "agnr_1",
    selected_agent_id: agent,
    action,
    shadow_mode: false,
    proposed: { id: "prop_1", status: "pending", policy_decision_id: "pd_1" },
    reason: {},
  };
}
