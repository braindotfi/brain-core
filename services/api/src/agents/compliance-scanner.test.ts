import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { MockMetrics, newTenantId } from "@brain/shared";
import type { AgentRunResult } from "@brain/agent-router";
import { runComplianceScanCycle, type ComplianceFindingRow } from "./compliance-scanner.js";

const tenantA = newTenantId();
const tenantB = newTenantId();

describe("runComplianceScanCycle", () => {
  it("runs one compliance proposal per row and respects cooldown", async () => {
    const row = finding({ tenant_id: tenantA, finding_id: "pi_1" });
    const scanPool = scanPoolWith([row]);
    const appPool = cooldownPool();
    const run = vi.fn(
      async (_ctx: unknown, _input: unknown): Promise<AgentRunResult> => ({
        status: "proposal_created",
        routing_decision_id: "agrd_1",
        run_id: "agnr_1",
        selected_agent_id: "compliance",
        action: "escalate",
        shadow_mode: false,
        proposed: { id: "prop_1", status: "pending", policy_decision_id: "pd_prop_1" },
        reason: {},
      }),
    );
    const metrics = new MockMetrics();

    await runComplianceScanCycle(
      { scanPool, appPool, runService: { run }, metrics },
      { now: new Date("2026-07-19T00:00:00.000Z"), cooldownMs: 86_400_000 },
    );
    await runComplianceScanCycle(
      { scanPool, appPool, runService: { run }, metrics },
      { now: new Date("2026-07-19T01:00:00.000Z"), cooldownMs: 86_400_000 },
    );

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: tenantA, actor: "compliance_scanner" }),
      expect.objectContaining({
        tenant_id: tenantA,
        event: "approval.missing",
        context: expect.objectContaining({
          finding_type: "approval_missing",
          severity: "medium",
          policy_decision_id: "pd_1",
          audit_event_id: "evt_1",
          payment_intent_id: "pi_1",
        }),
      }),
    );
    expect(metrics.calls.some((call) => call.name === "brain.compliance.scan.count")).toBe(true);
    expect(
      metrics.calls.some((call) => call.name === "brain.compliance.scan.last_success_unixtime"),
    ).toBe(true);
  });

  it("routes policy and audit findings to their specific events", async () => {
    const run = vi.fn(
      async (_ctx: unknown, _input: unknown): Promise<AgentRunResult> => ({
        status: "proposal_created",
        routing_decision_id: "agrd_1",
        run_id: "agnr_1",
        selected_agent_id: "compliance",
        action: "notify",
        shadow_mode: false,
        reason: {},
      }),
    );

    await runComplianceScanCycle(
      {
        scanPool: scanPoolWith([
          finding({
            finding_id: "pd_reject",
            finding_type: "policy_violation",
            severity: "high",
            event_hint: "policy.violation",
            payment_intent_id: null,
          }),
          finding({
            finding_id: "evt_gap",
            finding_type: "audit_gap_detected",
            severity: "critical",
            event_hint: "audit.gap_detected",
            payment_intent_id: null,
          }),
        ]),
        appPool: cooldownPool(),
        runService: { run },
      },
      { now: new Date("2026-07-19T00:00:00.000Z") },
    );

    expect(run.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({ event: "policy.violation" }),
      expect.objectContaining({ event: "audit.gap_detected" }),
    ]);
  });

  it("reports the true eligible backlog when the global cap is hit", async () => {
    const rows = [
      finding({ tenant_id: tenantA, finding_id: "pi_1" }),
      finding({ tenant_id: tenantA, finding_id: "pi_2" }),
      finding({ tenant_id: tenantB, finding_id: "pi_3" }),
    ];
    const scanPool = scanPoolWith(rows, { eligibleCount: "5", fairCount: "3" });
    const metrics = new MockMetrics();
    const log = { warn: vi.fn(), error: vi.fn() };
    const run = vi.fn(
      async (): Promise<AgentRunResult> => ({
        status: "proposal_created",
        routing_decision_id: "agrd_1",
        run_id: "agnr_1",
        selected_agent_id: "compliance",
        action: "escalate",
        shadow_mode: false,
        proposed: { id: "prop_1", status: "pending", policy_decision_id: "pd_prop_1" },
        reason: {},
      }),
    );

    await runComplianceScanCycle(
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
      "compliance scanner hit batch cap",
    );
    expect(metrics.calls).toContainEqual({
      kind: "increment",
      name: "brain.compliance.scan.dropped.count",
      value: 3,
      tags: { reason: "batch_cap" },
    });
  });

  it("handles an empty eligible set", async () => {
    const run = vi.fn();
    const metrics = new MockMetrics();

    await runComplianceScanCycle(
      { scanPool: scanPoolWith([]), appPool: cooldownPool(), runService: { run }, metrics },
      { now: new Date("2026-07-19T00:00:00.000Z") },
    );

    expect(run).not.toHaveBeenCalled();
    expect(metrics.calls).toHaveLength(0);
  });

  it("logs run failures and still records cooldown result", async () => {
    const log = { warn: vi.fn(), error: vi.fn() };
    const appPool = cooldownPool();
    const run = vi.fn(async () => {
      throw new Error("router down");
    });

    await runComplianceScanCycle(
      {
        scanPool: scanPoolWith([finding({ tenant_id: tenantA, finding_id: "pi_failure" })]),
        appPool,
        runService: { run },
        log,
      },
      { now: new Date("2026-07-19T00:00:00.000Z") },
    );

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: tenantA, findingId: "pi_failure" }),
      "compliance run failed",
    );
  });

  it("excludes cooldown rows using the structured compliance aging tier", async () => {
    const query = vi.fn(async (_text: string, _values?: unknown[]) => ({ rows: [], rowCount: 0 }));

    await runComplianceScanCycle(
      {
        scanPool: { query } as unknown as Pool,
        appPool: cooldownPool(),
        runService: { run: vi.fn() },
      },
      { now: new Date("2026-07-19T00:00:00.000Z") },
    );

    expect(String(query.mock.calls[0]?.[0])).toContain(
      "cd.aging_tier = ('compliance_' || f.finding_type)",
    );
  });
});

function finding(override: Partial<ComplianceFindingRow>): ComplianceFindingRow {
  return {
    tenant_id: tenantA,
    finding_id: "pi_1",
    finding_type: "approval_missing",
    severity: "medium",
    event_hint: "approval.missing",
    policy_decision_id: "pd_1",
    audit_event_id: "evt_1",
    payment_intent_id: "pi_1",
    subject_type: "payment_intent",
    subject_id: "pi_1",
    policy_outcome: "confirm",
    rule_id: "approval_required",
    required_approvers_count: "1",
    valid_approval_count: "0",
    stale_approval_count: "0",
    detected_at: "2026-07-18T00:00:00.000Z",
    ...override,
  };
}

function scanPoolWith(
  rows: ComplianceFindingRow[],
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
