import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { MockMetrics, newTenantId, type DirectoryProvider } from "@brain/shared";
import type { AgentRunResult } from "@brain/agent-router";
import {
  runSubscriptionManagementScanCycle,
  type SubscriptionManagementRow,
} from "./subscription-management-scanner.js";

const tenantA = newTenantId();

describe("runSubscriptionManagementScanCycle", () => {
  it("does nothing with the default none directory provider", async () => {
    const run = vi.fn(async (): Promise<AgentRunResult> => result());

    await runSubscriptionManagementScanCycle({
      scanPool: scanPoolWith([subscription({})]),
      appPool: cooldownPool(),
      runService: { run },
    });

    expect(run).not.toHaveBeenCalled();
  });

  it("emits seat underutilization when directory usage is below threshold", async () => {
    const run = vi.fn(async (): Promise<AgentRunResult> => result());
    const metrics = new MockMetrics();
    const directoryProvider: DirectoryProvider = {
      kind: "okta",
      async listSubscriptionUsage() {
        return [
          {
            subscription_id: "cp_1",
            licensed: 10,
            active_30d: 4,
            active_users: [
              {
                name: "Ada Lovelace",
                email: "ada@example.com",
                last_active: "2026-09-19",
                apps_used: ["Acme SaaS"],
              },
            ],
          },
        ];
      },
    };

    await runSubscriptionManagementScanCycle(
      {
        scanPool: scanPoolWith([subscription({})]),
        appPool: cooldownPool(),
        runService: { run },
        directoryProvider,
        metrics,
      },
      { now: new Date("2026-09-20T00:00:00.000Z") },
    );

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: tenantA, actor: "subscription_management_scanner" }),
      expect.objectContaining({
        tenant_id: tenantA,
        event: "subscription.seats_underutilized",
        context: expect.objectContaining({
          subscription_id: "cp_1",
          seats: expect.objectContaining({ licensed: 10, active_30d: 4 }),
          underutilization: expect.objectContaining({ percent: 60 }),
          options: expect.arrayContaining([expect.objectContaining({ label: "downgrade" })]),
        }),
      }),
    );
    expect(
      metrics.calls.some((call) => call.name === "brain.subscription_management.scan.count"),
    ).toBe(true);
  });
});

function subscription(override: Partial<SubscriptionManagementRow>): SubscriptionManagementRow {
  return {
    tenant_id: tenantA,
    subscription_id: "cp_1",
    transaction_id: "tx_1",
    counterparty_id: "cp_1",
    merchant: "Acme SaaS",
    amount: "1000.00",
    currency: "USD",
    transaction_date: "2026-09-20T00:00:00.000Z",
    current_plan: "Team",
    renewal_date: "2026-12-01",
    category: null,
    ...override,
  };
}

function scanPoolWith(rows: SubscriptionManagementRow[]): Pool {
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
    selected_agent_id: "subscription_management",
    action: "downgrade",
    shadow_mode: false,
    proposed: { id: "prop_1", status: "pending", policy_decision_id: "pd_1" },
    reason: {},
  };
}
