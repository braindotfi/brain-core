import { describe, expect, it, vi } from "vitest";
import {
  InMemoryAuditEmitter,
  newAccountId,
  newAgentId,
  newCounterpartyId,
  newPaymentIntentId,
  newPolicyDecisionId,
  newTenantId,
  type ServiceCallContext,
} from "@brain/shared";
import type { PaymentIntentRow } from "@brain/ledger";
import type { Pool } from "pg";
import { ApprovalService } from "../approvals/ApprovalService.js";
import { OutboxService } from "../outbox/OutboxService.js";
import { PaymentIntentService } from "./PaymentIntentService.js";

const TENANT = newTenantId();
const AGENT = newAgentId();
const PAYMENT_INTENT = newPaymentIntentId();

const CTX: ServiceCallContext = {
  tenantId: TENANT,
  actor: "user_01TEST0000000000000000000",
  principalType: "user",
  scopes: ["payment_intent:approve"],
};

describe("PaymentIntentService decision state", () => {
  it("stores rejection status and its decision receipt in one update", async () => {
    const audit = new InMemoryAuditEmitter();
    const updates: Array<{ sql: string; values: unknown[] }> = [];
    const pool = fakePool(updates);
    const service = new PaymentIntentService({
      pool,
      audit,
      outbox: new OutboxService(),
      approvals: new ApprovalService({ pool, audit, resolveRole: async () => null }),
      resolveAgent: async () => null,
      resolveAccount: async () => null,
      resolveCounterparty: async () => null,
      resolvePrincipal: async () => ({ id: CTX.actor, type: "user", scopes: [] }),
      evaluatePolicy: async () => {
        throw new Error("policy evaluation should not run during rejection");
      },
    });

    const result = await service.reject(CTX, PAYMENT_INTENT, "not approved");

    expect(result).toMatchObject({
      status: "rejected",
      decision: "reject",
      decision_audit_id: expect.stringMatching(/^evt_/),
      decided_at: expect.any(String),
    });
    const transition = updates.find((call) => call.sql.includes("SET status = $1"));
    expect(transition?.sql).toContain("decision = COALESCE($4, decision)");
    expect(transition?.values.slice(0, 5)).toEqual([
      "rejected",
      PAYMENT_INTENT,
      "pending_approval",
      "reject",
      result.decision_audit_id,
    ]);
    expect(audit.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: result.decision_audit_id,
          action: "proposal.decided",
          inputs: { proposal_id: PAYMENT_INTENT, decision: "reject" },
        }),
      ]),
    );
  });
});

function fakePool(updates: Array<{ sql: string; values: unknown[] }>): Pool {
  let row = paymentIntentRow();
  const client = {
    query: vi.fn(async (sql: string, values: unknown[] = []) => {
      if (
        sql === "BEGIN" ||
        sql === "COMMIT" ||
        sql === "ROLLBACK" ||
        sql.startsWith("SELECT set_config")
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("SELECT * FROM ledger_payment_intents WHERE id = $1")) {
        return { rows: [row], rowCount: 1 };
      }
      if (sql.startsWith("UPDATE ledger_payment_intents") && sql.includes("SET status = $1")) {
        updates.push({ sql, values });
        row = {
          ...row,
          status: values[0] as string,
          decision: values[3] as "reject",
          decision_audit_id: values[4] as string,
          decided_at: new Date(values[5] as string),
          updated_at: new Date(),
        };
        return { rows: [row], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
  return { connect: vi.fn(async () => client) } as unknown as Pool;
}

function paymentIntentRow(): PaymentIntentRow {
  return {
    id: PAYMENT_INTENT,
    owner_id: TENANT,
    created_by_agent_id: AGENT,
    action_type: "ach_outbound",
    source_account_id: newAccountId(),
    destination_counterparty_id: newCounterpartyId(),
    amount: "10.00",
    currency: "USD",
    obligation_id: null,
    invoice_id: null,
    status: "pending_approval",
    policy_decision_id: newPolicyDecisionId(),
    approval_ids: [],
    execution_receipt_ids: [],
    source_ids: [],
    evidence_ids: [],
    provenance: "agent_contributed",
    confidence: 1,
    evidence_score: null,
    risk_level: null,
    proposal_dedup_key: null,
    decision: null,
    decision_audit_id: null,
    decided_at: null,
    settlement_pay_to: null,
    escrow_id: null,
    job_terms_hash: null,
    created_at: new Date("2026-09-13T00:00:00.000Z"),
    updated_at: new Date("2026-09-13T00:00:00.000Z"),
  };
}
