/**
 * PolicyService.evaluateForGate — confidence gating (RFC 0004 §5.2).
 *
 * Proves the end-to-end lever: a tenant policy rule `agent.confidence.gte`
 * now gates a payment intent on the confidence threaded onto the intent. The
 * fake pool answers getActive with one active policy and swallows the
 * policy_decisions insert.
 */

import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  InMemoryAuditEmitter,
  newAccountId,
  newAgentId,
  newCounterpartyId,
  newPaymentIntentId,
  newTenantId,
  type GatePaymentIntent,
  type ServiceCallContext,
} from "@brain/shared";
import { PolicyService } from "./service.js";
import type { PolicyDocument } from "./dsl.js";

const POLICY: PolicyDocument = {
  version: 1,
  rules: [
    { id: "gate", applies_to: ["any"], when: { "agent.confidence.gte": 0.8 }, execute: "auto" },
  ],
};

function poolWithActivePolicy(content: PolicyDocument): Pool {
  const row = {
    id: "pol_01TEST0000000000000000000",
    tenant_id: "tnt_01TEST0000000000000000000",
    version: 1,
    content,
    content_hash: Buffer.from("00", "hex"),
    quorum_required: 1,
    state: "active",
    created_by: "usr_01TEST0000000000000000000",
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
  };
  const client = {
    query: vi.fn((sql: string) => {
      if (
        sql === "BEGIN" ||
        sql === "COMMIT" ||
        sql === "ROLLBACK" ||
        sql.startsWith("SELECT set_config")
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (sql.includes("FROM policies")) {
        return Promise.resolve({ rows: [row] as unknown[], rowCount: 1 });
      }
      // policy_decisions insert and anything else
      return Promise.resolve({ rows: [], rowCount: 0 });
    }),
    release: vi.fn(),
  };
  return { connect: vi.fn(() => Promise.resolve(client)) } as unknown as Pool;
}

function intent(confidence: number | null | undefined): GatePaymentIntent {
  return {
    id: newPaymentIntentId(),
    owner_id: newTenantId(),
    created_by_agent_id: newAgentId(),
    action_type: "ach_outbound",
    source_account_id: newAccountId(),
    destination_counterparty_id: newCounterpartyId(),
    amount: "100.00",
    currency: "USD",
    status: "proposed",
    policy_decision_id: null,
    evidence_ids: [],
    ...(confidence !== undefined ? { confidence } : {}),
  };
}

const ctx: ServiceCallContext = { tenantId: newTenantId(), actor: newAgentId() };

function service(): PolicyService {
  return new PolicyService({
    pool: poolWithActivePolicy(POLICY),
    audit: new InMemoryAuditEmitter(),
  });
}

describe("PolicyService.evaluateForGate — confidence gating (RFC 0004 §5.2)", () => {
  it("rejects an intent below the agent.confidence.gte threshold", async () => {
    const decision = await service().evaluateForGate(ctx, intent(0.4));
    expect(decision.outcome).toBe("reject");
  });

  it("allows an intent at/above the threshold", async () => {
    const decision = await service().evaluateForGate(ctx, intent(0.9));
    expect(decision.outcome).toBe("allow");
  });

  it("fails closed when the intent carries no confidence", async () => {
    const decision = await service().evaluateForGate(ctx, intent(undefined));
    expect(decision.outcome).toBe("reject");
  });
});
