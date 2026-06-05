/**
 * Create-path test — confidence capping (RFC 0004 §5.2).
 *
 * Proves create() caps a new intent's confidence at the referenced obligation's
 * (via resolveObligationConfidence), so a low-confidence document-extracted
 * obligation flows into both the create-time policy evaluation and the stored
 * row. Uses a fake pool that returns a row for the insert.
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
  newObligationId,
  type GatePaymentIntent,
  type GatePolicyDecision,
  type GatePrincipal,
  type ServiceCallContext,
  type CreatePaymentIntentInput,
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
const OBL = newObligationId();
const PD = newPolicyDecisionId();
const ctx: ServiceCallContext = { tenantId: TENANT, actor: AGENT, requestId: "req_test" };

const DECISION: GatePolicyDecision = {
  id: PD,
  outcome: "allow",
  matched_rule_id: "r",
  required_approvers: [],
  ledger_snapshot_hash: "h",
  trace: [],
  required_evidence_kinds: [],
  counterparty_verification_threshold: null,
  amount_upper_bound: null,
};

const GATE_PRINCIPAL: GatePrincipal = {
  id: AGENT,
  type: "agent",
  scopes: ["payment_intent:execute"],
};

function insertedRow(): PaymentIntentRow {
  return {
    id: newPaymentIntentId(),
    owner_id: TENANT,
    created_by_agent_id: AGENT,
    action_type: "ach_outbound",
    source_account_id: ACCT,
    destination_counterparty_id: CP,
    amount: "100.00",
    currency: "USD",
    obligation_id: OBL,
    invoice_id: null,
    status: "approved",
    policy_decision_id: PD,
    approval_ids: [],
    execution_receipt_ids: [],
    source_ids: [],
    evidence_ids: [],
    provenance: "inferred",
    confidence: 0.4,
    proposal_dedup_key: null,
    settlement_pay_to: null,
    escrow_id: null,
    job_terms_hash: null,
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
  };
}

function makeFakePool(): { pool: Pool; calls: { sql: string; values: unknown[] }[] } {
  const calls: { sql: string; values: unknown[] }[] = [];
  const client = {
    query: vi.fn((sql: string, values?: unknown[]) => {
      calls.push({ sql, values: values ?? [] });
      if (
        sql === "BEGIN" ||
        sql === "COMMIT" ||
        sql === "ROLLBACK" ||
        sql.startsWith("SELECT set_config")
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (sql.includes("INSERT INTO ledger_payment_intents")) {
        return Promise.resolve({ rows: [insertedRow()], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    }),
    release: vi.fn(),
  };
  return { pool: { connect: vi.fn(() => Promise.resolve(client)) } as unknown as Pool, calls };
}

function makeService(
  pool: Pool,
  audit: InMemoryAuditEmitter,
  opts: {
    resolveObligationConfidence?: (ctx: ServiceCallContext, id: string) => Promise<number | null>;
    onPolicy?: (intent: GatePaymentIntent) => void;
  } = {},
): PaymentIntentService {
  return new PaymentIntentService({
    pool,
    audit,
    outbox: new OutboxService(),
    approvals: new ApprovalService({ pool, audit, resolveRole: async () => null }),
    resolveAgent: async () => null,
    resolveAccount: async () => null,
    resolveCounterparty: async () => null,
    resolvePrincipal: async () => GATE_PRINCIPAL,
    evaluatePolicy: async (_ctx, intent) => {
      opts.onPolicy?.(intent);
      return DECISION;
    },
    ...(opts.resolveObligationConfidence !== undefined
      ? { resolveObligationConfidence: opts.resolveObligationConfidence }
      : {}),
  });
}

const baseInput: CreatePaymentIntentInput = {
  action_type: "ach_outbound",
  source_account_id: ACCT,
  destination_counterparty_id: CP,
  amount: "100.00",
  currency: "USD",
  obligation_id: OBL,
  agent_id: AGENT,
};

function insertConfidence(calls: { sql: string; values: unknown[] }[]): unknown {
  const insert = calls.find((c) => c.sql.includes("INSERT INTO ledger_payment_intents"));
  // confidence is the 14th positional param ($14) -> values index 13.
  return insert?.values[13];
}

describe("PaymentIntentService.create — confidence capping (RFC 0004 §5.2)", () => {
  it("caps the intent confidence at the referenced obligation's", async () => {
    const audit = new InMemoryAuditEmitter();
    const { pool, calls } = makeFakePool();
    let seen: GatePaymentIntent | undefined;
    const service = makeService(pool, audit, {
      resolveObligationConfidence: async () => 0.4,
      onPolicy: (i) => {
        seen = i;
      },
    });

    await service.create(ctx, baseInput);

    // create-time policy evaluation sees the capped confidence…
    expect(seen?.confidence).toBe(0.4);
    // …and the stored row carries it.
    expect(insertConfidence(calls)).toBe(0.4);
  });

  it("takes the minimum of an explicit input confidence and the obligation's", async () => {
    const audit = new InMemoryAuditEmitter();
    const { pool, calls } = makeFakePool();
    const service = makeService(pool, audit, { resolveObligationConfidence: async () => 0.6 });

    await service.create(ctx, { ...baseInput, confidence: 0.3 });

    expect(insertConfidence(calls)).toBe(0.3);
  });

  it("defaults to 1.0 when no resolver is wired and no input confidence is given", async () => {
    const audit = new InMemoryAuditEmitter();
    const { pool, calls } = makeFakePool();
    const service = makeService(pool, audit); // no resolveObligationConfidence

    await service.create(ctx, baseInput);

    expect(insertConfidence(calls)).toBe(1.0);
  });
});
