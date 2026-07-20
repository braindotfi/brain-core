import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { MockMetrics, newTenantId } from "@brain/shared";
import type { AgentRunResult } from "@brain/agent-router";
import { runVendorRiskScanCycle, type VendorRiskRow } from "./vendor-risk-scanner.js";

const tenantA = newTenantId();
const tenantB = newTenantId();

describe("runVendorRiskScanCycle", () => {
  it("runs one vendor risk proposal per row and respects cooldown", async () => {
    const row = vendor({ tenant_id: tenantA, counterparty_id: "cp_1" });
    const scanPool = scanPoolWith([row]);
    const appPool = cooldownPool();
    const run = vi.fn(
      async (_ctx: unknown, _input: unknown): Promise<AgentRunResult> => ({
        status: "proposal_created",
        routing_decision_id: "agrd_1",
        run_id: "agnr_1",
        selected_agent_id: "vendor_risk",
        action: "flag_vendor_risk",
        shadow_mode: false,
        proposed: { id: "prop_1", status: "pending", policy_decision_id: "pd_1" },
        reason: {},
      }),
    );
    const metrics = new MockMetrics();

    await runVendorRiskScanCycle(
      { scanPool, appPool, runService: { run }, metrics },
      { now: new Date("2026-07-19T00:00:00.000Z"), cooldownMs: 86_400_000 },
    );
    await runVendorRiskScanCycle(
      { scanPool, appPool, runService: { run }, metrics },
      { now: new Date("2026-07-19T01:00:00.000Z"), cooldownMs: 86_400_000 },
    );

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: tenantA, actor: "vendor_risk_scanner" }),
      expect.objectContaining({
        tenant_id: tenantA,
        event: "vendor.bank_details_changed",
        context: expect.objectContaining({
          counterparty_id: "cp_1",
          vendor_id: "cp_1",
          vendor_name: "Acme",
          identity_resolved: false,
          verified_status: "unverified",
          payment_destination_id: "cpi_1",
          counterparty_history_id: "cpi_1",
        }),
      }),
    );
    expect(metrics.calls.some((call) => call.name === "brain.vendor_risk.scan.count")).toBe(true);
    expect(
      metrics.calls.some((call) => call.name === "brain.vendor_risk.scan.last_success_unixtime"),
    ).toBe(true);
  });

  it("passes verified vendor identity status into context", async () => {
    const row = vendor({
      verified_status: "document_verified",
      history_risk_score: "0.6",
    });
    const run = vi.fn(
      async (_ctx: unknown, _input: unknown): Promise<AgentRunResult> => ({
        status: "proposal_created",
        routing_decision_id: "agrd_1",
        run_id: "agnr_1",
        selected_agent_id: "vendor_risk",
        action: "flag_vendor_risk",
        shadow_mode: false,
        reason: {},
      }),
    );

    await runVendorRiskScanCycle(
      { scanPool: scanPoolWith([row]), appPool: cooldownPool(), runService: { run } },
      { now: new Date("2026-07-19T00:00:00.000Z") },
    );

    expect(run.mock.calls[0]?.[1]).toMatchObject({
      context: {
        identity_resolved: true,
        verified_status: "document_verified",
      },
    });
  });

  it("uses payment.destination_changed when the row is marked as a payment destination event", async () => {
    const row = vendor({ event_hint: "payment.destination_changed" });
    const run = vi.fn(
      async (_ctx: unknown, _input: unknown): Promise<AgentRunResult> => ({
        status: "proposal_created",
        routing_decision_id: "agrd_1",
        run_id: "agnr_1",
        selected_agent_id: "vendor_risk",
        action: "require_approval",
        shadow_mode: false,
        reason: {},
      }),
    );

    await runVendorRiskScanCycle(
      { scanPool: scanPoolWith([row]), appPool: cooldownPool(), runService: { run } },
      { now: new Date("2026-07-19T00:00:00.000Z") },
    );

    expect(run.mock.calls[0]?.[1]).toMatchObject({ event: "payment.destination_changed" });
  });

  it("falls back to vendor.created for an unknown event hint", async () => {
    const row = vendor({ event_hint: "unexpected" });
    const run = vi.fn(
      async (_ctx: unknown, _input: unknown): Promise<AgentRunResult> => ({
        status: "proposal_created",
        routing_decision_id: "agrd_1",
        run_id: "agnr_1",
        selected_agent_id: "vendor_risk",
        action: "flag_vendor_risk",
        shadow_mode: false,
        reason: {},
      }),
    );

    await runVendorRiskScanCycle(
      { scanPool: scanPoolWith([row]), appPool: cooldownPool(), runService: { run } },
      { now: new Date("2026-07-19T00:00:00.000Z") },
    );

    expect(run.mock.calls[0]?.[1]).toMatchObject({ event: "vendor.created" });
  });

  it("reports the true eligible backlog when the global cap is hit", async () => {
    const rows = [
      vendor({ tenant_id: tenantA, counterparty_id: "cp_1" }),
      vendor({ tenant_id: tenantA, counterparty_id: "cp_2" }),
      vendor({ tenant_id: tenantB, counterparty_id: "cp_3" }),
    ];
    const scanPool = scanPoolWith(rows, { eligibleCount: "5", fairCount: "3" });
    const metrics = new MockMetrics();
    const log = { warn: vi.fn(), error: vi.fn() };
    const run = vi.fn(
      async (): Promise<AgentRunResult> => ({
        status: "proposal_created",
        routing_decision_id: "agrd_1",
        run_id: "agnr_1",
        selected_agent_id: "vendor_risk",
        action: "flag_vendor_risk",
        shadow_mode: false,
        proposed: { id: "prop_1", status: "pending", policy_decision_id: "pd_1" },
        reason: {},
      }),
    );

    await runVendorRiskScanCycle(
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
      "vendor risk scanner hit batch cap",
    );
    expect(metrics.calls).toContainEqual({
      kind: "increment",
      name: "brain.vendor_risk.scan.dropped.count",
      value: 3,
      tags: { reason: "batch_cap" },
    });
  });

  it("handles an empty eligible set", async () => {
    const run = vi.fn();
    const metrics = new MockMetrics();

    await runVendorRiskScanCycle(
      { scanPool: scanPoolWith([]), appPool: cooldownPool(), runService: { run }, metrics },
      { now: new Date("2026-07-19T00:00:00.000Z") },
    );

    expect(run).not.toHaveBeenCalled();
    expect(metrics.calls).toHaveLength(0);
  });
});

function vendor(override: Partial<VendorRiskRow>): VendorRiskRow {
  return {
    tenant_id: tenantA,
    counterparty_id: "cp_1",
    vendor_name: "Acme",
    verified_status: "unverified",
    risk_level: null,
    created_at: "2026-07-18T00:00:00.000Z",
    payment_destination_id: "cpi_1",
    payment_destination_changed_at: "2026-07-18T00:00:00.000Z",
    prior_destination_hash: "old_hash",
    current_destination_hash: "new_hash",
    destination_name: "Acme",
    history_risk_score: "0.85",
    event_hint: "vendor.bank_details_changed",
    ...override,
  };
}

function scanPoolWith(
  rows: VendorRiskRow[],
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
