import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { MockMetrics, newTenantId } from "@brain/shared";
import type { AgentRunResult } from "@brain/agent-router";
import {
  runObligationAnomalyScanCycle,
  type ObligationAnomalyRow,
} from "./obligation-anomaly-scanner.js";

const tenantA = newTenantId();
const tenantB = newTenantId();

describe("runObligationAnomalyScanCycle", () => {
  it("runs one invoice_integrity proposal per row and respects cooldown", async () => {
    const row = obligation({ tenant_id: tenantA, obligation_id: "obl_1" });
    const scanPool = scanPoolWith([row]);
    const appPool = cooldownPool();
    const run = vi.fn(
      async (_ctx: unknown, _input: unknown): Promise<AgentRunResult> => ({
        status: "proposal_created",
        routing_decision_id: "agrd_1",
        run_id: "agnr_1",
        selected_agent_id: "invoice_integrity",
        action: "flag_duplicate_invoice",
        shadow_mode: false,
        proposed: { id: "prop_1", status: "pending", policy_decision_id: "pd_1" },
        reason: {},
      }),
    );
    const metrics = new MockMetrics();

    await runObligationAnomalyScanCycle(
      { scanPool, appPool, runService: { run }, metrics },
      { now: new Date("2026-08-16T00:00:00.000Z"), cooldownMs: 86_400_000 },
    );
    await runObligationAnomalyScanCycle(
      { scanPool, appPool, runService: { run }, metrics },
      { now: new Date("2026-08-16T01:00:00.000Z"), cooldownMs: 86_400_000 },
    );

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: tenantA, actor: "obligation_anomaly_scanner" }),
      expect.objectContaining({
        tenant_id: tenantA,
        event: "obligation.duplicate_suspected",
        context: expect.objectContaining({
          obligation_id: "obl_1",
          counterparty_id: "cp_1",
          amount: "48750.00",
          related_obligation_ids: ["obl_prior"],
        }),
      }),
    );
    expect(
      metrics.calls.some((call) => call.name === "brain.invoice_integrity.scan.count"),
    ).toBe(true);
    expect(
      metrics.calls.some(
        (call) => call.name === "brain.invoice_integrity.scan.last_success_unixtime",
      ),
    ).toBe(true);
  });

  it("routes a structuring hint to obligation.structuring_suspected with the group ids", async () => {
    const row = obligation({
      event_hint: "obligation.structuring_suspected",
      duplicate_obligation_ids: [],
      structuring_group_ids: ["obl_2", "obl_3"],
      structuring_group_total: "9825.00",
    });
    const run = vi.fn(
      async (_ctx: unknown, _input: unknown): Promise<AgentRunResult> => ({
        status: "proposal_created",
        routing_decision_id: "agrd_1",
        run_id: "agnr_1",
        selected_agent_id: "invoice_integrity",
        action: "flag_structuring",
        shadow_mode: false,
        reason: {},
      }),
    );

    await runObligationAnomalyScanCycle(
      { scanPool: scanPoolWith([row]), appPool: cooldownPool(), runService: { run } },
      { now: new Date("2026-08-16T00:00:00.000Z") },
    );

    expect(run.mock.calls[0]?.[1]).toMatchObject({
      event: "obligation.structuring_suspected",
      context: expect.objectContaining({
        related_obligation_ids: ["obl_2", "obl_3"],
        group_total_amount: "9825.00",
      }),
    });
  });

  it("routes a threshold-avoidance hint with the threshold amount", async () => {
    const row = obligation({
      event_hint: "obligation.threshold_avoidance_suspected",
      duplicate_obligation_ids: [],
      threshold_amount: "90000",
    });
    const run = vi.fn(
      async (_ctx: unknown, _input: unknown): Promise<AgentRunResult> => ({
        status: "proposal_created",
        routing_decision_id: "agrd_1",
        run_id: "agnr_1",
        selected_agent_id: "invoice_integrity",
        action: "flag_threshold_avoidance",
        shadow_mode: false,
        reason: {},
      }),
    );

    await runObligationAnomalyScanCycle(
      { scanPool: scanPoolWith([row]), appPool: cooldownPool(), runService: { run } },
      { now: new Date("2026-08-16T00:00:00.000Z") },
    );

    expect(run.mock.calls[0]?.[1]).toMatchObject({
      event: "obligation.threshold_avoidance_suspected",
      context: expect.objectContaining({ threshold_amount: "90000" }),
    });
  });

  it("falls back to obligation.high_value_new_vendor for an unknown event hint", async () => {
    const row = obligation({ event_hint: "unexpected", duplicate_obligation_ids: [] });
    const run = vi.fn(
      async (_ctx: unknown, _input: unknown): Promise<AgentRunResult> => ({
        status: "proposal_created",
        routing_decision_id: "agrd_1",
        run_id: "agnr_1",
        selected_agent_id: "invoice_integrity",
        action: "flag_unverified_vendor",
        shadow_mode: false,
        reason: {},
      }),
    );

    await runObligationAnomalyScanCycle(
      { scanPool: scanPoolWith([row]), appPool: cooldownPool(), runService: { run } },
      { now: new Date("2026-08-16T00:00:00.000Z") },
    );

    expect(run.mock.calls[0]?.[1]).toMatchObject({ event: "obligation.high_value_new_vendor" });
  });

  it("reports the true eligible backlog when the global cap is hit", async () => {
    const rows = [
      obligation({ tenant_id: tenantA, obligation_id: "obl_1" }),
      obligation({ tenant_id: tenantA, obligation_id: "obl_2" }),
      obligation({ tenant_id: tenantB, obligation_id: "obl_3" }),
    ];
    const scanPool = scanPoolWith(rows, { eligibleCount: "6", fairCount: "3" });
    const metrics = new MockMetrics();
    const log = { warn: vi.fn(), error: vi.fn() };
    const run = vi.fn(
      async (): Promise<AgentRunResult> => ({
        status: "proposal_created",
        routing_decision_id: "agrd_1",
        run_id: "agnr_1",
        selected_agent_id: "invoice_integrity",
        action: "flag_duplicate_invoice",
        shadow_mode: false,
        proposed: { id: "prop_1", status: "pending", policy_decision_id: "pd_1" },
        reason: {},
      }),
    );

    await runObligationAnomalyScanCycle(
      { scanPool, appPool: cooldownPool(), runService: { run }, metrics, log },
      {
        now: new Date("2026-08-16T00:00:00.000Z"),
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
      "obligation anomaly scanner hit batch cap",
    );
    expect(metrics.calls).toContainEqual({
      kind: "increment",
      name: "brain.invoice_integrity.scan.dropped.count",
      value: 4,
      tags: { reason: "batch_cap" },
    });
  });

  it("handles an empty eligible set", async () => {
    const run = vi.fn();
    const metrics = new MockMetrics();

    await runObligationAnomalyScanCycle(
      { scanPool: scanPoolWith([]), appPool: cooldownPool(), runService: { run }, metrics },
      { now: new Date("2026-08-16T00:00:00.000Z") },
    );

    expect(run).not.toHaveBeenCalled();
    expect(metrics.calls).toHaveLength(0);
  });
});

function obligation(override: Partial<ObligationAnomalyRow>): ObligationAnomalyRow {
  return {
    tenant_id: tenantA,
    obligation_id: "obl_1",
    counterparty_id: "cp_1",
    counterparty_name: "Vantage Point Consulting",
    counterparty_verified_status: "unverified",
    amount_due: "48750.00",
    currency: "USD",
    due_date: "2026-08-15",
    duplicate_obligation_ids: ["obl_prior"],
    structuring_group_ids: [],
    structuring_group_total: null,
    threshold_amount: null,
    event_hint: "obligation.duplicate_suspected",
    ...override,
  };
}

function scanPoolWith(
  rows: ObligationAnomalyRow[],
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
