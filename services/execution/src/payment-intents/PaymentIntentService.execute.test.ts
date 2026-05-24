/**
 * Execute-path integration test.
 *
 * Tests the full approve → §6 gate → rail dispatch → audit trail sequence
 * without a real database. Uses a fake pool that returns predefined rows for
 * each SQL pattern the service issues.
 */

import { describe, expect, it, vi } from "vitest";
import {
  InMemoryAuditEmitter,
  newTenantId,
  newAgentId,
  newPaymentIntentId,
  newAccountId,
  newCounterpartyId,
  newPolicyDecisionId,
} from "@brain/shared";
import type {
  GateAccount,
  GateAgent,
  GateCounterparty,
  GatePolicyDecision,
  GatePrincipal,
  ServiceCallContext,
} from "@brain/shared";
import type { Pool } from "pg";
import { PaymentIntentService } from "./PaymentIntentService.js";
import { ApprovalService } from "../approvals/ApprovalService.js";
import { OutboxService } from "../outbox/OutboxService.js";
import type { PaymentIntentRow } from "@brain/ledger";

// ---------------------------------------------------------------------------
// Constants — generated at module load so all IDs are valid Brain ULIDs
// ---------------------------------------------------------------------------

const TENANT = newTenantId();
const AGENT_ID = newAgentId();
const PI_ID = newPaymentIntentId();
const ACCT_ID = newAccountId();
const CP_ID = newCounterpartyId();
const PD_ID = newPolicyDecisionId();

const ctx: ServiceCallContext = {
  tenantId: TENANT,
  actor: AGENT_ID,
  requestId: "req_test",
};

const APPROVED_INTENT_ROW: PaymentIntentRow = {
  id: PI_ID,
  owner_id: TENANT,
  created_by_agent_id: AGENT_ID,
  action_type: "ach_outbound",
  source_account_id: ACCT_ID,
  destination_counterparty_id: CP_ID,
  amount: "100.00",
  currency: "USD",
  obligation_id: null,
  invoice_id: null,
  proposal_dedup_key: null,
  status: "approved",
  policy_decision_id: PD_ID,
  approval_ids: [],
  execution_receipt_ids: [],
  source_ids: [],
  evidence_ids: [],
  provenance: "test",
  confidence: 1,
  created_at: new Date("2026-01-01T00:00:00Z"),
  updated_at: new Date("2026-01-01T00:00:00Z"),
};

// ---------------------------------------------------------------------------
// Fake pool factory
// ---------------------------------------------------------------------------

/**
 * Creates a mock pg.Pool whose clients handle SET CONFIG, BEGIN, COMMIT, ROLLBACK
 * transparently, and route business queries through the supplied handler.
 */
function makeFakePool(
  queryFn: (sql: string, values: unknown[]) => { rows: unknown[]; rowCount: number },
): Pool {
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
      return Promise.resolve(queryFn(sql, values ?? []));
    }),
    release: vi.fn(),
  };
  return {
    connect: vi.fn(() => Promise.resolve(client)),
  } as unknown as Pool;
}

// ---------------------------------------------------------------------------
// Resolver fixtures
// ---------------------------------------------------------------------------

const GATE_PRINCIPAL: GatePrincipal = {
  id: AGENT_ID,
  type: "agent",
  scopes: ["payment_intent:execute"],
};

const GATE_AGENT: GateAgent = {
  id: AGENT_ID,
  state: "active",
  scope: { canExecutePayments: true },
};

const GATE_ACCOUNT: GateAccount = {
  id: ACCT_ID,
  status: "active",
  currency: "USD",
  available_balance: "5000.00",
};

const GATE_CP: GateCounterparty = {
  id: CP_ID,
  type: "vendor",
  risk_level: "low",
  verified_status: "document_verified",
};

const POLICY_DECISION: GatePolicyDecision = {
  id: PD_ID,
  outcome: "allow",
  matched_rule_id: "allow-small",
  required_approvers: [],
  ledger_snapshot_hash: "abc123",
  trace: [],
  required_evidence_kinds: [],
  counterparty_verification_threshold: null,
  amount_upper_bound: null,
};

// ---------------------------------------------------------------------------
// Service factory
// ---------------------------------------------------------------------------

function makeService(pool: Pool, audit: InMemoryAuditEmitter): PaymentIntentService {
  const approvals = new ApprovalService({
    pool,
    audit,
    resolveRole: async () => null,
  });

  return new PaymentIntentService({
    pool,
    audit,
    outbox: new OutboxService(),
    approvals,
    resolveAgent: async (_ctx, _id) => GATE_AGENT,
    resolveAccount: async (_ctx, _id) => GATE_ACCOUNT,
    resolveCounterparty: async (_ctx, _id) => GATE_CP,
    evaluatePolicy: async (_ctx, _intent) => POLICY_DECISION,
    resolvePrincipal: async (_ctx) => GATE_PRINCIPAL,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PaymentIntentService.execute — durable hand-off (approved → dispatching)", () => {
  it("runs the §6 gate, enqueues the outbox row, and returns 202 dispatching", async () => {
    const audit = new InMemoryAuditEmitter();

    const dispatchingRow: PaymentIntentRow = { ...APPROVED_INTENT_ROW, status: "dispatching" };

    const pool = makeFakePool((sql) => {
      // findPaymentIntentById (requireIntent + gate approvals read)
      if (sql.includes("FROM ledger_payment_intents WHERE id")) {
        return { rows: [APPROVED_INTENT_ROW], rowCount: 1 };
      }
      // approved → dispatching transition
      if (sql.includes("UPDATE ledger_payment_intents")) {
        return { rows: [dispatchingRow], rowCount: 1 };
      }
      // outbox enqueue (idempotent insert RETURNING id)
      if (sql.includes("INSERT INTO execution_outbox")) {
        return { rows: [{ id: "exo_test" }], rowCount: 1 };
      }
      // approvals.signedRoles (SELECT approval_ids)
      if (sql.includes("approval_ids")) {
        return { rows: [APPROVED_INTENT_ROW], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const service = makeService(pool, audit);
    const result = await service.execute(ctx, PI_ID);

    // H-04: execute no longer settles synchronously — it hands off to the outbox.
    expect(result.payment_intent_id).toBe(PI_ID);
    expect(result.status).toBe("dispatching");
    expect(result.execution_id).toBeNull();
    expect(result.outbox_id).toBe("exo_test");
    expect(result.rail).toBe("bank_ach");

    const actions = audit.events.map((e) => e.action);
    // Gate emits audit-before; execute records the dispatching write…
    expect(actions).toContain("payment_intent.execute.before");
    expect(actions).toContain("payment_intent.execute.enqueued");
    // …and the §6 audit-after now closes in the worker, NOT here.
    expect(actions).not.toContain("payment_intent.execute.after");

    const enq = audit.events.find((e) => e.action === "payment_intent.execute.enqueued");
    expect(enq?.outputs.outbox_id).toBe("exo_test");
    expect(enq?.outputs.status).toBe("dispatching");
    expect(enq?.policyDecisionId).toBe(PD_ID);
  });

  it("aborts without enqueuing when the intent was paused between gate and hand-off", async () => {
    const audit = new InMemoryAuditEmitter();
    const pool = makeFakePool((sql) => {
      if (sql.includes("FROM ledger_payment_intents WHERE id")) {
        return { rows: [APPROVED_INTENT_ROW], rowCount: 1 };
      }
      // The conditional approved → dispatching UPDATE matches no row (paused).
      if (sql.includes("UPDATE ledger_payment_intents")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("approval_ids")) {
        return { rows: [APPROVED_INTENT_ROW], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const service = makeService(pool, audit);
    await expect(service.execute(ctx, PI_ID)).rejects.toMatchObject({
      code: "payment_intent_invalid_state",
    });

    // Aborted hand-off must NOT enqueue and must NOT claim success.
    const actions = audit.events.map((e) => e.action);
    expect(actions).not.toContain("payment_intent.execute.enqueued");
    const after = audit.events.find((e) => e.action === "payment_intent.execute.after");
    expect(after?.outputs.aborted).toBe(true);
  });
});

describe("PaymentIntentService.completeExecution / failExecution (outbox callbacks)", () => {
  it("completeExecution settles dispatching → executed", async () => {
    const dispatchingRow: PaymentIntentRow = { ...APPROVED_INTENT_ROW, status: "dispatching" };
    const executedRow: PaymentIntentRow = { ...APPROVED_INTENT_ROW, status: "executed" };
    const pool = makeFakePool((sql) => {
      if (sql.includes("FROM ledger_payment_intents WHERE id")) {
        return { rows: [dispatchingRow], rowCount: 1 };
      }
      if (sql.includes("INTO executions")) {
        return {
          rows: [{ id: "exec_1", tenant_id: TENANT, proposal_id: PI_ID, status: "dispatched" }],
          rowCount: 1,
        };
      }
      if (sql.includes("UPDATE executions") || sql.includes("UPDATE ledger_payment_intents")) {
        return { rows: [executedRow], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const service = makeService(pool, new InMemoryAuditEmitter());
    await expect(
      service.completeExecution(ctx, {
        paymentIntentId: PI_ID,
        executionId: "exec_1",
        rail: "bank_ach",
        railReceipt: { rail: "ach", ach_trace: "t" },
        idempotencyKey: `pi:${PI_ID}:${PD_ID}`,
      }),
    ).resolves.toBeUndefined();
  });

  it("completeExecution is a no-op when the intent is already executed (idempotent replay)", async () => {
    const executedRow: PaymentIntentRow = { ...APPROVED_INTENT_ROW, status: "executed" };
    const insertSpy = vi.fn();
    const pool = makeFakePool((sql) => {
      if (sql.includes("FROM ledger_payment_intents WHERE id")) {
        return { rows: [executedRow], rowCount: 1 };
      }
      if (sql.includes("INTO executions")) {
        insertSpy();
        return { rows: [{ id: "exec_1" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const service = makeService(pool, new InMemoryAuditEmitter());
    await service.completeExecution(ctx, {
      paymentIntentId: PI_ID,
      executionId: "exec_dup",
      rail: "bank_ach",
      railReceipt: { rail: "ach", ach_trace: "t" },
      idempotencyKey: `pi:${PI_ID}:${PD_ID}`,
    });
    // Must short-circuit before inserting a duplicate execution row.
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("failExecution moves dispatching → failed", async () => {
    const failedRow: PaymentIntentRow = { ...APPROVED_INTENT_ROW, status: "failed" };
    const pool = makeFakePool((sql) =>
      sql.includes("UPDATE ledger_payment_intents")
        ? { rows: [failedRow], rowCount: 1 }
        : { rows: [], rowCount: 0 },
    );
    const service = makeService(pool, new InMemoryAuditEmitter());
    await expect(service.failExecution(ctx, { paymentIntentId: PI_ID })).resolves.toBeUndefined();
  });
});

describe("PaymentIntentService.execute — gate failure path", () => {
  it("emits audit-after with ok:false when gate fails, then throws payment_intent_gate_failed", async () => {
    const audit = new InMemoryAuditEmitter();

    const pool = makeFakePool((sql) => {
      if (sql.includes("FROM ledger_payment_intents WHERE id")) {
        return { rows: [APPROVED_INTENT_ROW], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const approvals = new ApprovalService({
      pool,
      audit,
      resolveRole: async () => null,
    });

    // Gate fails: policy returns "reject"
    const service = new PaymentIntentService({
      pool,
      audit,
      outbox: new OutboxService(),
      approvals,
      resolveAgent: async () => GATE_AGENT,
      resolveAccount: async () => GATE_ACCOUNT,
      resolveCounterparty: async () => GATE_CP,
      evaluatePolicy: async () => ({
        ...POLICY_DECISION,
        outcome: "reject" as const,
        matched_rule_id: "block-all",
      }),
      resolvePrincipal: async () => GATE_PRINCIPAL,
    });

    await expect(service.execute(ctx, PI_ID)).rejects.toMatchObject({
      code: "payment_intent_gate_failed",
    });

    // The gate fails at check 3 (before check 13 where execute.before is emitted),
    // so only execute.after is present in the audit trail.
    const actions = audit.events.map((e) => e.action);
    expect(actions).toContain("payment_intent.execute.after");
    expect(actions).not.toContain("payment_intent.execute.before");

    const afterEvent = audit.events.find((e) => e.action === "payment_intent.execute.after");
    expect(afterEvent?.outputs.ok).toBe(false);
    expect(afterEvent?.outputs.gate_failed).toBe(true);
  });

  it("throws payment_intent_invalid_state when intent is not approved", async () => {
    const audit = new InMemoryAuditEmitter();
    const proposedRow: PaymentIntentRow = { ...APPROVED_INTENT_ROW, status: "proposed" };

    const pool = makeFakePool((sql) => {
      if (sql.includes("FROM ledger_payment_intents WHERE id")) {
        return { rows: [proposedRow], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const service = makeService(pool, audit);
    await expect(service.execute(ctx, PI_ID)).rejects.toMatchObject({
      code: "payment_intent_invalid_state",
    });

    // No audit events — gate was never reached
    expect(audit.events).toHaveLength(0);
  });
});
