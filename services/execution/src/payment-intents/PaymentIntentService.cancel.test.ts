/**
 * Cancel-path test (BRAIN-95).
 *
 * cancel() used to accept only status="proposed", even though the MCP tool
 * (services/mcp/src/tools/payment-intent.ts) documented and enforced a wider
 * CANCELLABLE_STATUSES set including "pending_approval". pending_approval
 * carries no recorded approval signature yet (approve() only advances it once
 * one lands), so widening the service to match is safe: cancelling from there
 * withdraws the proposing agent still-unreviewed proposal, not a decision
 * anyone else already made. Uses a fake pool that tracks one mutable row
 * status so the transition CAS (WHERE id = $2 AND status = $3) behaves like
 * the real repository.
 */

import { describe, expect, it, vi } from "vitest";
import {
  InMemoryAuditEmitter,
  newTenantId,
  newAgentId,
  newAccountId,
  newCounterpartyId,
  newPaymentIntentId,
  newPolicyDecisionId,
  type ServiceCallContext,
} from "@brain/shared";
import type { Pool } from "pg";
import type { PaymentIntentRow } from "@brain/ledger";
import { PaymentIntentService } from "./PaymentIntentService.js";
import { ApprovalService } from "../approvals/ApprovalService.js";
import { OutboxService } from "../outbox/OutboxService.js";

const TENANT = newTenantId();
const AGENT = newAgentId();
const ACCT = newAccountId();
const CP = newCounterpartyId();
const PD = newPolicyDecisionId();
const PI = newPaymentIntentId();
const ctx: ServiceCallContext = { tenantId: TENANT, actor: AGENT, requestId: "req_test" };

function baseRow(status: string): PaymentIntentRow {
  return {
    id: PI,
    owner_id: TENANT,
    created_by_agent_id: AGENT,
    action_type: "ach_outbound",
    source_account_id: ACCT,
    destination_counterparty_id: CP,
    amount: "100.00",
    currency: "USD",
    obligation_id: null,
    invoice_id: null,
    status,
    policy_decision_id: PD,
    approval_ids: [],
    execution_receipt_ids: [],
    source_ids: [],
    evidence_ids: [],
    provenance: "inferred",
    confidence: 1,
    evidence_score: null,
    risk_level: null,
    proposal_dedup_key: null,
    settlement_pay_to: null,
    escrow_id: null,
    job_terms_hash: null,
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
  };
}

/**
 * A fake pool that tracks one mutable payment-intent status server-side, so
 * the transition CAS (UPDATE ... WHERE id = $2 AND status = $3) either
 * succeeds and advances it or is a genuine no-op miss, matching the real
 * repository.
 */
function makeFakePool(initialStatus: string): {
  pool: Pool;
  getStatus: () => string;
} {
  let status = initialStatus;
  const client = {
    query: vi.fn((sql: string, values?: unknown[]) => {
      if (
        sql === "BEGIN" ||
        sql === "COMMIT" ||
        sql === "ROLLBACK" ||
        sql.startsWith("SELECT set_config")
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (sql.includes("SELECT * FROM ledger_payment_intents WHERE id = $1")) {
        return Promise.resolve({ rows: [baseRow(status)], rowCount: 1 });
      }
      if (sql.startsWith("UPDATE ledger_payment_intents") && sql.includes("SET status = $1")) {
        const [to, , from] = values as [string, string, string];
        if (from === status) {
          status = to;
          return Promise.resolve({ rows: [baseRow(status)], rowCount: 1 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    }),
    release: vi.fn(),
  };
  return {
    pool: { connect: vi.fn(() => Promise.resolve(client)) } as unknown as Pool,
    getStatus: () => status,
  };
}

function makeService(pool: Pool, audit: InMemoryAuditEmitter): PaymentIntentService {
  return new PaymentIntentService({
    pool,
    audit,
    outbox: new OutboxService(),
    approvals: new ApprovalService({ pool, audit, resolveRole: async () => null }),
    resolveAgent: async () => null,
    resolveAccount: async () => null,
    resolveCounterparty: async () => null,
    resolvePrincipal: async () => ({ id: AGENT, type: "agent", scopes: [] }),
    evaluatePolicy: async () => {
      throw new Error("evaluatePolicy should not run on cancel");
    },
  });
}

describe("PaymentIntentService.cancel", () => {
  it("cancels from proposed (pre-existing behavior)", async () => {
    const audit = new InMemoryAuditEmitter();
    const { pool, getStatus } = makeFakePool("proposed");
    const service = makeService(pool, audit);

    const result = await service.cancel(ctx, PI);

    expect(result.status).toBe("cancelled");
    expect(getStatus()).toBe("cancelled");
    expect(audit.events).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: "payment_intent.cancelled" })]),
    );
  });

  it("BRAIN-95: cancels from pending_approval (no approval signature recorded yet)", async () => {
    const audit = new InMemoryAuditEmitter();
    const { pool, getStatus } = makeFakePool("pending_approval");
    const service = makeService(pool, audit);

    const result = await service.cancel(ctx, PI);

    expect(result.status).toBe("cancelled");
    expect(getStatus()).toBe("cancelled");
  });

  it.each([
    "awaiting_second_approval",
    "approved",
    "paused",
    "dispatching",
    "rejected",
    "executed",
    "failed",
    "cancelled",
  ])("rejects cancel from %s", async (status) => {
    const audit = new InMemoryAuditEmitter();
    const { pool, getStatus } = makeFakePool(status);
    const service = makeService(pool, audit);

    await expect(service.cancel(ctx, PI)).rejects.toMatchObject({
      code: "payment_intent_invalid_state",
    });
    // Untouched -- the CAS never ran.
    expect(getStatus()).toBe(status);
  });

  it("surfaces PaymentIntent moved during cancel when the row changes state between read and transition", async () => {
    const audit = new InMemoryAuditEmitter();
    let status = "pending_approval";
    let reads = 0;
    const client = {
      query: vi.fn((sql: string, values?: unknown[]) => {
        if (
          sql === "BEGIN" ||
          sql === "COMMIT" ||
          sql === "ROLLBACK" ||
          sql.startsWith("SELECT set_config")
        ) {
          return Promise.resolve({ rows: [], rowCount: 0 });
        }
        if (sql.includes("SELECT * FROM ledger_payment_intents WHERE id = $1")) {
          reads += 1;
          const snapshot = status;
          if (reads === 1) {
            // requireIntent reads pending_approval, then a concurrent
            // approve() moves the row out from under the transition CAS.
            status = "approved";
          }
          return Promise.resolve({ rows: [baseRow(snapshot)], rowCount: 1 });
        }
        if (sql.startsWith("UPDATE ledger_payment_intents") && sql.includes("SET status = $1")) {
          const [to, , from] = values as [string, string, string];
          if (from === status) {
            status = to;
            return Promise.resolve({ rows: [baseRow(status)], rowCount: 1 });
          }
          return Promise.resolve({ rows: [], rowCount: 0 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(() => Promise.resolve(client)) } as unknown as Pool;
    const service = makeService(pool, audit);

    await expect(service.cancel(ctx, PI)).rejects.toMatchObject({
      code: "payment_intent_invalid_state",
      message: expect.stringContaining("moved during cancel"),
    });
  });
});
