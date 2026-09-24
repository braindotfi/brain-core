import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { MockMetrics, newTenantId, type KycStore } from "@brain/shared";
import type { AgentRunResult } from "@brain/agent-router";
import {
  runAmlComplianceScanCycle,
  type AmlCompliancePaymentRow,
} from "./aml-compliance-scanner.js";

const tenantA = newTenantId();

describe("runAmlComplianceScanCycle", () => {
  it("does nothing when there are no eligible payments", async () => {
    const run = vi.fn(async (): Promise<AgentRunResult> => result());

    await runAmlComplianceScanCycle({
      scanPool: scanPoolWith([]),
      appPool: cooldownPool(),
      runService: { run },
    });

    expect(run).not.toHaveBeenCalled();
  });

  it("emits cross-border AML context with stub screenings", async () => {
    const run = vi.fn(async (): Promise<AgentRunResult> => result());
    const metrics = new MockMetrics();

    await runAmlComplianceScanCycle(
      {
        scanPool: scanPoolWith([
          payment({ source_jurisdiction: "AE", beneficiary_jurisdiction: "US" }),
        ]),
        appPool: cooldownPool(),
        runService: { run },
        metrics,
      },
      { now: new Date("2026-09-20T00:00:00.000Z") },
    );

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: tenantA, actor: "aml_compliance_scanner" }),
      expect.objectContaining({
        tenant_id: tenantA,
        event: "payment.cross_border_created",
        context: expect.objectContaining({
          payment_id: "pi_1",
          beneficiary_id: "cp_1",
          jurisdictions_involved: ["AE", "US"],
          recommended_action: "provide_docs",
          screenings: expect.objectContaining({
            ofac: expect.objectContaining({ status: "clear" }),
            pep: expect.objectContaining({ status: "clear" }),
          }),
        }),
      }),
    );
    expect(metrics.calls.some((call) => call.name === "brain.aml_compliance.scan.count")).toBe(
      true,
    );
  });

  it("emits stale KYC events when the store reports stale freshness", async () => {
    const run = vi.fn(async (): Promise<AgentRunResult> => result());
    const kycStore: KycStore = {
      async getFreshness() {
        return { status: "stale", note: "fixture" };
      },
    };

    await runAmlComplianceScanCycle({
      scanPool: scanPoolWith([payment({ amount: "10.00", beneficiary_jurisdiction: "US" })]),
      appPool: cooldownPool(),
      runService: { run },
      kycStore,
    });

    expect((run.mock.calls as unknown as Array<[unknown, unknown]>)[0]?.[1]).toMatchObject({
      event: "kyc.beneficiary_stale",
    });
  });

  it("recommends hold when screening returns a possible match", async () => {
    const run = vi.fn(async (): Promise<AgentRunResult> => result());

    await runAmlComplianceScanCycle({
      scanPool: scanPoolWith([
        payment({ source_jurisdiction: "AE", beneficiary_jurisdiction: "US" }),
      ]),
      appPool: cooldownPool(),
      runService: { run },
      ofacScreener: {
        async screen(_subject, now) {
          return {
            status: "possible_match",
            lists_checked: ["fixture"],
            timestamp: now.toISOString(),
          };
        },
      },
    });

    expect((run.mock.calls as unknown as Array<[unknown, unknown]>)[0]?.[1]).toMatchObject({
      context: expect.objectContaining({ recommended_action: "hold" }),
    });
  });
});

function payment(override: Partial<AmlCompliancePaymentRow>): AmlCompliancePaymentRow {
  return {
    tenant_id: tenantA,
    payment_id: "pi_1",
    beneficiary_id: "cp_1",
    beneficiary_name: "Vendor",
    amount: "12000.00",
    currency: "USD",
    payment_created_at: "2026-09-20T00:00:00.000Z",
    source_jurisdiction: null,
    beneficiary_jurisdiction: "US",
    ...override,
  };
}

function scanPoolWith(rows: AmlCompliancePaymentRow[]): Pool {
  const enriched = rows.map((row) => ({
    ...row,
    eligible_count: rows.length,
    fair_count: rows.length,
  }));
  return {
    query: vi.fn(async () => ({ rows: enriched, rowCount: enriched.length })),
  } as unknown as Pool;
}

function cooldownPool(): Pool {
  const keys = new Set<string>();
  const client = {
    query: vi.fn(async (text: string, values: unknown[] = []) => {
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
      if (text.startsWith("SELECT set_config")) return { rows: [] };
      if (text.includes("INSERT INTO agent_trigger_cooldowns")) {
        const key = String(values[0]);
        if (keys.has(key)) return { rows: [] };
        keys.add(key);
        return { rows: [{ trigger_key: key }] };
      }
      return { rows: [] };
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
    selected_agent_id: "aml_compliance",
    action: "provide_docs",
    shadow_mode: false,
    proposed: { id: "prop_1", status: "pending", policy_decision_id: "pd_1" },
    reason: {},
  };
}
