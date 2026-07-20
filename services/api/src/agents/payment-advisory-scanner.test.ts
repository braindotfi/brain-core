import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { MockMetrics, newTenantId } from "@brain/shared";
import type { AgentRunResult } from "@brain/agent-router";
import {
  runPaymentAdvisoryScanCycle,
  type PaymentAdvisoryRow,
} from "./payment-advisory-scanner.js";

const tenantA = newTenantId();
const tenantB = newTenantId();

describe("runPaymentAdvisoryScanCycle", () => {
  it("runs one payment advisory per payable and respects cooldown", async () => {
    const row = payable({ tenant_id: tenantA, obligation_id: "obl_1" });
    const scanPool = scanPoolWith([row]);
    const appPool = cooldownPool();
    const run = vi.fn(async (): Promise<AgentRunResult> => result());
    const metrics = new MockMetrics();

    await runPaymentAdvisoryScanCycle(
      { scanPool, appPool, runService: { run }, metrics },
      { now: new Date("2026-07-19T00:00:00.000Z"), cooldownMs: 86_400_000 },
    );
    await runPaymentAdvisoryScanCycle(
      { scanPool, appPool, runService: { run }, metrics },
      { now: new Date("2026-07-19T01:00:00.000Z"), cooldownMs: 86_400_000 },
    );

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: tenantA, actor: "payment_advisory_scanner" }),
      expect.objectContaining({
        tenant_id: tenantA,
        event: "payable.due_soon",
        context: expect.objectContaining({
          obligation_id: "obl_1",
          counterparty_id: "cp_1",
          payment_destination_id: "cpi_1",
          source_account_id: "acct_1",
          amount: "500.00",
          currency: "USD",
        }),
      }),
    );
    expect(metrics.calls.some((call) => call.name === "brain.payment.scan.count")).toBe(true);
  });

  it("uses payable.discount_expiring for expiring discount rows", async () => {
    const row = payable({ event_hint: "payable.discount_expiring" });
    const run = vi.fn(async (): Promise<AgentRunResult> => result());

    await runPaymentAdvisoryScanCycle(
      { scanPool: scanPoolWith([row]), appPool: cooldownPool(), runService: { run } },
      { now: new Date("2026-07-19T00:00:00.000Z") },
    );

    expect(run).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ event: "payable.discount_expiring" }),
    );
  });

  it("reports the true eligible backlog when the global cap is hit", async () => {
    const rows = [
      payable({ tenant_id: tenantA, obligation_id: "obl_1" }),
      payable({ tenant_id: tenantA, obligation_id: "obl_2" }),
      payable({ tenant_id: tenantB, obligation_id: "obl_3" }),
    ];
    const scanPool = scanPoolWith(rows, { eligibleCount: 5, fairCount: 3 });
    const metrics = new MockMetrics();
    const log = { warn: vi.fn(), error: vi.fn() };
    const run = vi.fn(async (): Promise<AgentRunResult> => result());

    await runPaymentAdvisoryScanCycle(
      { scanPool, appPool: cooldownPool(), runService: { run }, metrics, log },
      { now: new Date("2026-07-19T00:00:00.000Z"), batchSize: 2, perTenantBatchSize: 2 },
    );

    expect(run).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ total_eligible: 5, total_fair: 3, omitted_count: 3 }),
      "payment advisory scanner hit batch cap",
    );
    expect(metrics.calls).toContainEqual({
      kind: "increment",
      name: "brain.payment.scan.dropped.count",
      value: 3,
      tags: { reason: "batch_cap" },
    });
  });
});

function payable(override: Partial<PaymentAdvisoryRow>): PaymentAdvisoryRow {
  return {
    tenant_id: tenantA,
    obligation_id: "obl_1",
    counterparty_id: "cp_1",
    counterparty_name: "Vendor",
    payment_destination_id: "cpi_1",
    source_account_id: "acct_1",
    amount: "500.00",
    currency: "USD",
    due_date: "2026-07-25T00:00:00.000Z",
    available_cash: "1000.00",
    discount_expires_at: null,
    discount_amount: null,
    event_hint: "payable.due_soon",
    ...override,
  };
}

function scanPoolWith(
  rows: PaymentAdvisoryRow[],
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

function result(): AgentRunResult {
  return {
    status: "proposal_created",
    routing_decision_id: "agrd_1",
    run_id: "agnr_1",
    selected_agent_id: "payment",
    action: "request_approval",
    shadow_mode: false,
    proposed: { id: "prop_1", status: "pending", policy_decision_id: "pd_1" },
    reason: {},
  };
}
