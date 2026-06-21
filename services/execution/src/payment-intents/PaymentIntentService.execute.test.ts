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
  GatePaymentIntent,
  GatePolicyDecision,
  GatePrincipal,
  ServiceCallContext,
  AgentAttestationInput,
  TenantScopedClient,
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
  settlement_pay_to: null,
  escrow_id: null,
  job_terms_hash: null,
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

function makeService(
  pool: Pool,
  audit: InMemoryAuditEmitter,
  recordAgentSpend?: (
    client: TenantScopedClient,
    input: { tenantId: string; agentId: string; amount: string; currency: string },
  ) => Promise<void>,
): PaymentIntentService {
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
    ...(recordAgentSpend !== undefined ? { recordAgentSpend } : {}),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PaymentIntentService.execute — durable hand-off (approved → dispatching)", () => {
  it("runs the §6 gate, enqueues the outbox row, and returns 202 dispatching", async () => {
    const audit = new InMemoryAuditEmitter();

    const dispatchingRow: PaymentIntentRow = { ...APPROVED_INTENT_ROW, status: "dispatching" };
    const reservationIds: string[] = [];
    const outboxReservationIds: unknown[] = [];

    const pool = makeFakePool((sql, values) => {
      // findPaymentIntentById (requireIntent + gate approvals read)
      if (sql.includes("FROM ledger_payment_intents WHERE id")) {
        return { rows: [APPROVED_INTENT_ROW], rowCount: 1 };
      }
      // approved → dispatching transition
      if (sql.includes("UPDATE ledger_payment_intents")) {
        return { rows: [dispatchingRow], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO ledger_reservations")) {
        reservationIds.push(String(values[0]));
        return { rows: [{ id: values[0] }], rowCount: 1 };
      }
      // outbox enqueue (idempotent insert RETURNING id)
      if (sql.includes("INSERT INTO execution_outbox")) {
        outboxReservationIds.push(values[8]);
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
    expect(reservationIds).toHaveLength(1);
    expect(reservationIds[0]).toMatch(/^rsv_/);
    expect(outboxReservationIds).toEqual(reservationIds);

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

  it("threads the row confidence into the gate intent for policy (RFC 0004 §5.2)", async () => {
    const audit = new InMemoryAuditEmitter();
    const lowConfRow: PaymentIntentRow = { ...APPROVED_INTENT_ROW, confidence: 0.4 };
    const dispatchingRow: PaymentIntentRow = { ...lowConfRow, status: "dispatching" };

    const pool = makeFakePool((sql, values) => {
      if (sql.includes("FROM ledger_payment_intents WHERE id")) {
        return { rows: [lowConfRow], rowCount: 1 };
      }
      if (sql.includes("UPDATE ledger_payment_intents")) {
        return { rows: [dispatchingRow], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO ledger_reservations")) {
        return { rows: [{ id: values[0] }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO execution_outbox")) {
        return { rows: [{ id: "exo_test" }], rowCount: 1 };
      }
      if (sql.includes("approval_ids")) {
        return { rows: [lowConfRow], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    let seen: GatePaymentIntent | undefined;
    const approvals = new ApprovalService({ pool, audit, resolveRole: async () => null });
    const service = new PaymentIntentService({
      pool,
      audit,
      outbox: new OutboxService(),
      approvals,
      resolveAgent: async (_ctx, _id) => GATE_AGENT,
      resolveAccount: async (_ctx, _id) => GATE_ACCOUNT,
      resolveCounterparty: async (_ctx, _id) => GATE_CP,
      evaluatePolicy: async (_ctx, intent) => {
        seen = intent;
        return POLICY_DECISION;
      },
      resolvePrincipal: async (_ctx) => GATE_PRINCIPAL,
    });

    await service.execute(ctx, PI_ID);
    // The §6 gate re-evaluates policy on the intent built from the row; that
    // intent must carry the row's confidence so `agent.confidence.gte` can gate.
    expect(seen?.confidence).toBe(0.4);
  });

  it("aborts without enqueuing when the intent was paused between gate and hand-off", async () => {
    const audit = new InMemoryAuditEmitter();
    const reservationInsert = vi.fn();
    const pool = makeFakePool((sql, values) => {
      if (sql.includes("FROM ledger_payment_intents WHERE id")) {
        return { rows: [APPROVED_INTENT_ROW], rowCount: 1 };
      }
      // The conditional approved → dispatching UPDATE matches no row (paused).
      if (sql.includes("UPDATE ledger_payment_intents")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("INSERT INTO ledger_reservations")) {
        reservationInsert();
        return { rows: [{ id: values[0] }], rowCount: 1 };
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
    expect(reservationInsert).not.toHaveBeenCalled();
    const after = audit.events.find((e) => e.action === "payment_intent.execute.after");
    expect(after?.outputs.aborted).toBe(true);
  });
});

describe("PaymentIntentService.completeExecution / failExecution (outbox callbacks)", () => {
  it("completeExecution settles dispatching → executed", async () => {
    const dispatchingRow: PaymentIntentRow = { ...APPROVED_INTENT_ROW, status: "dispatching" };
    const executedRow: PaymentIntentRow = { ...APPROVED_INTENT_ROW, status: "executed" };
    const consumedReservations: unknown[] = [];
    const pool = makeFakePool((sql, values) => {
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
      if (sql.includes("UPDATE ledger_reservations")) {
        consumedReservations.push(values[1]);
        return { rows: [], rowCount: 1 };
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
        reservationId: "rsv_1",
      }),
    ).resolves.toBeUndefined();
    expect(consumedReservations).toEqual(["rsv_1"]);
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

  it("completeExecution refuses to settle a row with no policy_decision_id (§6 runtime invariant)", async () => {
    // A row that somehow reached `dispatching` without the §6 gate having run.
    // Defense-in-depth: even if the outbox-side guard is bypassed, this row must
    // not be allowed to transition to `executed`.
    const orphanRow: PaymentIntentRow = {
      ...APPROVED_INTENT_ROW,
      status: "dispatching",
      policy_decision_id: null,
    };
    const insertSpy = vi.fn();
    const pool = makeFakePool((sql) => {
      if (sql.includes("FROM ledger_payment_intents WHERE id")) {
        return { rows: [orphanRow], rowCount: 1 };
      }
      if (sql.includes("INTO executions")) {
        insertSpy();
        return { rows: [{ id: "exec_1" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const service = makeService(pool, new InMemoryAuditEmitter());
    await expect(
      service.completeExecution(ctx, {
        paymentIntentId: PI_ID,
        executionId: "exec_orphan",
        rail: "bank_ach",
        railReceipt: { rail: "ach", ach_trace: "t" },
        idempotencyKey: `pi:${PI_ID}:none`,
      }),
    ).rejects.toMatchObject({
      code: "payment_intent_invalid_state",
      message: expect.stringContaining("policy_decision_id"),
    });
    // Must reject BEFORE any execution row is inserted.
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("completeExecution rejects when dispatching → executed loses the state race", async () => {
    const dispatchingRow: PaymentIntentRow = { ...APPROVED_INTENT_ROW, status: "dispatching" };
    const receiptAppendSpy = vi.fn();
    const pool = makeFakePool((sql) => {
      if (sql.includes("FROM ledger_payment_intents WHERE id")) {
        return { rows: [dispatchingRow], rowCount: 1 };
      }
      if (sql.includes("INTO executions")) {
        return { rows: [{ id: "exec_1" }], rowCount: 1 };
      }
      if (sql.includes("UPDATE executions")) {
        return { rows: [{ id: "exec_race", status: "in_flight" }], rowCount: 1 };
      }
      if (sql.includes("UPDATE ledger_payment_intents") && sql.includes("status = $1")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("array_append(execution_receipt_ids")) {
        receiptAppendSpy();
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const service = makeService(pool, new InMemoryAuditEmitter());

    await expect(
      service.completeExecution(ctx, {
        paymentIntentId: PI_ID,
        executionId: "exec_race",
        rail: "bank_ach",
        railReceipt: { rail: "ach", ach_trace: "t" },
        idempotencyKey: `pi:${PI_ID}:${PD_ID}`,
      }),
    ).rejects.toMatchObject({
      code: "payment_intent_invalid_state",
      message: expect.stringContaining("moved before executed transition"),
    });
    expect(receiptAppendSpy).not.toHaveBeenCalled();
  });

  it("completeExecution accumulates the agent spend counter on the executed path (R-21)", async () => {
    const dispatchingRow: PaymentIntentRow = { ...APPROVED_INTENT_ROW, status: "dispatching" };
    const executedRow: PaymentIntentRow = { ...APPROVED_INTENT_ROW, status: "executed" };
    const pool = makeFakePool((sql) => {
      if (sql.includes("FROM ledger_payment_intents WHERE id")) {
        return { rows: [dispatchingRow], rowCount: 1 };
      }
      if (sql.includes("INTO executions")) {
        return { rows: [{ id: "exec_1" }], rowCount: 1 };
      }
      if (sql.includes("UPDATE executions") || sql.includes("UPDATE ledger_payment_intents")) {
        return { rows: [executedRow], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const recordAgentSpend = vi.fn(async (_client: unknown, _input: unknown) => undefined);
    const service = makeService(pool, new InMemoryAuditEmitter(), recordAgentSpend);
    await service.completeExecution(ctx, {
      paymentIntentId: PI_ID,
      executionId: "exec_1",
      rail: "bank_ach",
      railReceipt: { rail: "ach", ach_trace: "t" },
      idempotencyKey: `pi:${PI_ID}:${PD_ID}`,
    });
    expect(recordAgentSpend).toHaveBeenCalledTimes(1);
    expect(recordAgentSpend.mock.calls[0]?.[1]).toEqual({
      tenantId: TENANT,
      agentId: AGENT_ID,
      amount: "100.00",
      currency: "USD",
    });
  });

  it("completeExecution skips the spend counter for an agent-less (human) intent", async () => {
    const dispatchingRow: PaymentIntentRow = {
      ...APPROVED_INTENT_ROW,
      status: "dispatching",
      created_by_agent_id: null,
    };
    const executedRow: PaymentIntentRow = {
      ...dispatchingRow,
      status: "executed",
    };
    const pool = makeFakePool((sql) => {
      if (sql.includes("FROM ledger_payment_intents WHERE id")) {
        return { rows: [dispatchingRow], rowCount: 1 };
      }
      if (sql.includes("INTO executions")) {
        return { rows: [{ id: "exec_1" }], rowCount: 1 };
      }
      if (sql.includes("UPDATE executions") || sql.includes("UPDATE ledger_payment_intents")) {
        return { rows: [executedRow], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const recordAgentSpend = vi.fn(async (_client: unknown, _input: unknown) => undefined);
    const service = makeService(pool, new InMemoryAuditEmitter(), recordAgentSpend);
    await service.completeExecution(ctx, {
      paymentIntentId: PI_ID,
      executionId: "exec_1",
      rail: "bank_ach",
      railReceipt: { rail: "ach", ach_trace: "t" },
      idempotencyKey: `pi:${PI_ID}:${PD_ID}`,
    });
    expect(recordAgentSpend).not.toHaveBeenCalled();
  });

  it("failExecution moves dispatching → failed", async () => {
    const failedRow: PaymentIntentRow = { ...APPROVED_INTENT_ROW, status: "failed" };
    const releasedReservations: unknown[] = [];
    const pool = makeFakePool((sql, values) => {
      if (sql.includes("UPDATE ledger_payment_intents")) {
        return { rows: [failedRow], rowCount: 1 };
      }
      if (sql.includes("UPDATE ledger_reservations")) {
        releasedReservations.push(values[1]);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const service = makeService(pool, new InMemoryAuditEmitter());
    await expect(
      service.failExecution(ctx, { paymentIntentId: PI_ID, reservationId: "rsv_1" }),
    ).resolves.toBeUndefined();
    expect(releasedReservations).toEqual(["rsv_1"]);
  });

  it("failExecution rejects when dispatching → failed loses the state race", async () => {
    const releasedReservations: unknown[] = [];
    const pool = makeFakePool((sql, values) => {
      if (sql.includes("UPDATE ledger_payment_intents")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("UPDATE ledger_reservations")) {
        releasedReservations.push(values[1]);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const service = makeService(pool, new InMemoryAuditEmitter());

    await expect(
      service.failExecution(ctx, { paymentIntentId: PI_ID, reservationId: "rsv_1" }),
    ).rejects.toMatchObject({
      code: "payment_intent_invalid_state",
      message: expect.stringContaining("moved before failed transition"),
    });
    expect(releasedReservations).toEqual([]);
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

// ---------------------------------------------------------------------------
// Phase 2C-C — gate-loader pass-through (RFC 0001 §6.3 / §6.4). Proves that
// attestCounterpartyAgent + sumAgentWindowSpend, when supplied to the service,
// reach the §6 gate (checks 5.5 / 8.5). The check logic itself is proven in
// shared/src/gate/gate.x402.test.ts; here we verify the wiring.
// ---------------------------------------------------------------------------

describe("PaymentIntentService.execute — x402 gate-loader pass-through (2C-C)", () => {
  const PAY_TO = "0x" + "ab".repeat(20);
  const X402_ROW: PaymentIntentRow = {
    ...APPROVED_INTENT_ROW,
    action_type: "x402_settle",
    currency: "USDC",
    amount: "1.00",
    settlement_pay_to: PAY_TO,
  };
  const AGENT_CP: GateCounterparty = {
    ...GATE_CP,
    type: "agent",
    agent_id: AGENT_ID,
    onchain_address: PAY_TO,
  };
  const USDC_ACCOUNT: GateAccount = { ...GATE_ACCOUNT, currency: "USDC" };

  function x402Pool(): Pool {
    return makeFakePool((sql) =>
      sql.includes("FROM ledger_payment_intents WHERE id")
        ? { rows: [X402_ROW], rowCount: 1 }
        : { rows: [], rowCount: 0 },
    );
  }

  it("forwards attestCounterpartyAgent → a non-attested agent payee hard-rejects at 5.5", async () => {
    const audit = new InMemoryAuditEmitter();
    const pool = x402Pool();
    const calls: AgentAttestationInput[] = [];
    const service = new PaymentIntentService({
      pool,
      audit,
      outbox: new OutboxService(),
      approvals: new ApprovalService({ pool, audit, resolveRole: async () => null }),
      resolveAgent: async () => GATE_AGENT,
      resolveAccount: async () => USDC_ACCOUNT,
      resolveCounterparty: async () => AGENT_CP,
      evaluatePolicy: async () => POLICY_DECISION,
      resolvePrincipal: async () => GATE_PRINCIPAL,
      attestCounterpartyAgent: async (_ctx, input) => {
        calls.push(input);
        return { attested: false, registered: true, paused: true };
      },
    });

    await expect(service.execute(ctx, PI_ID)).rejects.toMatchObject({
      code: "payment_intent_gate_failed",
    });
    // The loader was invoked with the agent payee's id (pass-through works).
    expect(calls).toHaveLength(1);
    expect(calls[0]!.counterpartyId).toBe(CP_ID);
    expect(calls[0]!.agentId).toBe(AGENT_ID);
  });

  it("forwards sumAgentWindowSpend → over the rolling-window cap hard-rejects at 8.5", async () => {
    const audit = new InMemoryAuditEmitter();
    const pool = x402Pool();
    const spendCalls: Array<{ agentId: string; windowSeconds: number }> = [];
    const service = new PaymentIntentService({
      pool,
      audit,
      outbox: new OutboxService(),
      approvals: new ApprovalService({ pool, audit, resolveRole: async () => null }),
      resolveAgent: async () => GATE_AGENT,
      resolveAccount: async () => USDC_ACCOUNT,
      resolveCounterparty: async () => AGENT_CP,
      evaluatePolicy: async () => ({
        ...POLICY_DECISION,
        micropayment_window_cap: { currency: "USDC", value: "10.00", window_seconds: 3600 },
      }),
      resolvePrincipal: async () => GATE_PRINCIPAL,
      // Attestation passes so the gate advances to the cap check.
      attestCounterpartyAgent: async () => ({ attested: true, registered: true, paused: false }),
      sumAgentWindowSpend: async (_ctx, agentId, windowSeconds) => {
        spendCalls.push({ agentId, windowSeconds });
        return "9.50"; // 9.50 + 1.00 = 10.50 > 10.00 cap
      },
    });

    await expect(service.execute(ctx, PI_ID)).rejects.toMatchObject({
      code: "payment_intent_gate_failed",
    });
    expect(spendCalls).toEqual([{ agentId: AGENT_ID, windowSeconds: 3600 }]);
  });

  it("does not create a ledger balance reservation for a successful x402 hand-off", async () => {
    const audit = new InMemoryAuditEmitter();
    const reservationInsert = vi.fn();
    const outboxReservationIds: unknown[] = [];
    const pool = makeFakePool((sql, values) => {
      if (sql.includes("FROM ledger_payment_intents WHERE id")) {
        return { rows: [X402_ROW], rowCount: 1 };
      }
      if (sql.includes("UPDATE ledger_payment_intents")) {
        return { rows: [{ ...X402_ROW, status: "dispatching" }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO ledger_reservations")) {
        reservationInsert();
        return { rows: [{ id: values[0] }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO execution_outbox")) {
        outboxReservationIds.push(values[8]);
        return { rows: [{ id: "exo_x402" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const service = new PaymentIntentService({
      pool,
      audit,
      outbox: new OutboxService(),
      approvals: new ApprovalService({ pool, audit, resolveRole: async () => null }),
      resolveAgent: async () => GATE_AGENT,
      resolveAccount: async () => USDC_ACCOUNT,
      resolveCounterparty: async () => AGENT_CP,
      evaluatePolicy: async () => POLICY_DECISION,
      resolvePrincipal: async () => GATE_PRINCIPAL,
      attestCounterpartyAgent: async () => ({ attested: true, registered: true, paused: false }),
    });

    const result = await service.execute(ctx, PI_ID);
    expect(result.status).toBe("dispatching");
    expect(result.rail).toBe("x402_base");
    expect(reservationInsert).not.toHaveBeenCalled();
    expect(outboxReservationIds).toEqual([null]);
  });
});

// ---------------------------------------------------------------------------
// Phase 3E-2 — escrow_release gate-loader pass-through (RFC 0001 §7.6). Proves
// resolveEscrowState reaches the §6 gate (check 6.6 — escrow-state binding).
// The check logic itself is proven in shared/src/gate/gate.escrow.test.ts.
// ---------------------------------------------------------------------------

describe("PaymentIntentService.execute — escrow gate-loader pass-through (3E-2)", () => {
  const PAYEE = "0x" + "ab".repeat(20);
  const ESCROW_ID = "0x" + "11".repeat(32);
  const TERMS = "0x" + "22".repeat(32);
  const ESCROW_ROW: PaymentIntentRow = {
    ...APPROVED_INTENT_ROW,
    action_type: "escrow_release",
    currency: "USDC",
    amount: "10.00",
    escrow_id: ESCROW_ID,
    job_terms_hash: TERMS,
  };
  const AGENT_CP: GateCounterparty = {
    ...GATE_CP,
    type: "agent",
    agent_id: AGENT_ID,
    onchain_address: PAYEE,
  };
  const USDC_ACCOUNT: GateAccount = { ...GATE_ACCOUNT, currency: "USDC" };

  it("forwards resolveEscrowState → a mismatched on-chain lock hard-rejects at 6.6", async () => {
    const audit = new InMemoryAuditEmitter();
    const pool = makeFakePool((sql) =>
      sql.includes("FROM ledger_payment_intents WHERE id")
        ? { rows: [ESCROW_ROW], rowCount: 1 }
        : { rows: [], rowCount: 0 },
    );
    const calls: string[] = [];
    const service = new PaymentIntentService({
      pool,
      audit,
      outbox: new OutboxService(),
      approvals: new ApprovalService({ pool, audit, resolveRole: async () => null }),
      resolveAgent: async () => GATE_AGENT,
      resolveAccount: async () => USDC_ACCOUNT,
      resolveCounterparty: async () => AGENT_CP,
      evaluatePolicy: async () => POLICY_DECISION,
      resolvePrincipal: async () => GATE_PRINCIPAL,
      resolveEscrowState: async (_ctx, input) => {
        calls.push(input.escrowId);
        // Locked + enough remaining + right terms, but a DIFFERENT payee → 6.6
        // must reject (only the payee mismatch trips the binding).
        return {
          state: "Locked",
          payer: "0x" + "cd".repeat(20),
          payee: "0x" + "99".repeat(20),
          token: "0x" + "ef".repeat(20),
          amount: "10.00",
          released: "0",
          refunded: "0",
          remaining: "10.00",
          jobTermsHash: TERMS,
        };
      },
    });

    await expect(service.execute(ctx, PI_ID)).rejects.toMatchObject({
      code: "payment_intent_gate_failed",
    });
    expect(calls).toEqual([ESCROW_ID]);
  });
});

// ---------------------------------------------------------------------------
// Peer review: prove the core safety loaders (checks 8 / 9.5 / 11.5) actually
// reach the §6 gate when wired through PaymentIntentService.gateDeps(). Each
// test spies on one loader and asserts it was invoked at least once during
// execute(); a hard rejection from that loader is the cleanest end-to-end
// signal that the threading reaches the gate.
// ---------------------------------------------------------------------------

describe("PaymentIntentService.execute — core safety loader pass-through (checks 8, 9.5, 11.5)", () => {
  function corePool(): Pool {
    return makeFakePool((sql) =>
      sql.includes("FROM ledger_payment_intents WHERE id")
        ? { rows: [APPROVED_INTENT_ROW], rowCount: 1 }
        : { rows: [], rowCount: 0 },
    );
  }

  it("forwards sumActiveReservations → reservation amount is subtracted from balance (check 8)", async () => {
    const audit = new InMemoryAuditEmitter();
    const pool = corePool();
    // available_balance is 5000; APPROVED_INTENT_ROW amount is 100. Reserve
    // 4950, leaving 50 free → 50 < 100 → check 8 hard-rejects.
    const reservationCalls: string[] = [];
    const service = new PaymentIntentService({
      pool,
      audit,
      outbox: new OutboxService(),
      approvals: new ApprovalService({ pool, audit, resolveRole: async () => null }),
      resolveAgent: async () => GATE_AGENT,
      resolveAccount: async () => GATE_ACCOUNT,
      resolveCounterparty: async () => GATE_CP,
      evaluatePolicy: async () => POLICY_DECISION,
      resolvePrincipal: async () => GATE_PRINCIPAL,
      sumActiveReservations: async (_ctx, accountId) => {
        reservationCalls.push(accountId);
        return "4950.00";
      },
    });

    await expect(service.execute(ctx, PI_ID)).rejects.toMatchObject({
      code: "payment_intent_gate_failed",
    });
    expect(reservationCalls).toEqual([ACCT_ID]);
  });

  it("forwards resolveEvidence → loader is invoked with the intent (check 9.5 reachable)", async () => {
    // Proves the loader is threaded through to the §6 gate. The pure
    // validateEvidence() rejection logic is covered exhaustively in
    // shared/src/gate/evidence-validator.test.ts; this test's purpose is
    // narrower: prove deps.resolveEvidence is called during execute().
    //
    // Intent must carry an evidence_id so check 9 (required_evidence_present)
    // passes and the gate advances to 9.5 where the loader fires.
    const audit = new InMemoryAuditEmitter();
    const WITH_EVIDENCE: PaymentIntentRow = {
      ...APPROVED_INTENT_ROW,
      evidence_ids: ["prs_test_evidence"],
    };
    const pool = makeFakePool((sql, values) => {
      if (sql.includes("FROM ledger_payment_intents WHERE id")) {
        return { rows: [WITH_EVIDENCE], rowCount: 1 };
      }
      if (sql.includes("UPDATE ledger_payment_intents")) {
        return { rows: [{ ...WITH_EVIDENCE, status: "dispatching" }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO ledger_reservations")) {
        return { rows: [{ id: values[0] }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO execution_outbox")) {
        return { rows: [{ id: "exo_evid" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const evidenceCalls: string[] = [];
    const service = new PaymentIntentService({
      pool,
      audit,
      outbox: new OutboxService(),
      approvals: new ApprovalService({ pool, audit, resolveRole: async () => null }),
      resolveAgent: async () => GATE_AGENT,
      resolveAccount: async () => GATE_ACCOUNT,
      resolveCounterparty: async () => GATE_CP,
      evaluatePolicy: async () => ({
        ...POLICY_DECISION,
        required_evidence_kinds: ["invoice"],
      }),
      resolvePrincipal: async () => GATE_PRINCIPAL,
      resolveEvidence: async (_ctx, intent) => {
        evidenceCalls.push(intent.id);
        // Return one piece of evidence so the validator sees it.
        return [
          {
            id: "prs_test_receipt",
            kind: "invoice",
            extracted: {},
            sourceArtifactId: "raw_x",
            capturedAt: new Date("2026-01-01"),
            trustLevel: "high",
          },
        ];
      },
    });

    // The intent's action_type is ach_outbound, which has no validator
    // registered, so validateEvidence returns passed=true and the gate
    // advances past 9.5. The threading check is the spy call list.
    await service.execute(ctx, PI_ID);
    expect(evidenceCalls).toEqual([PI_ID]);
  });

  it("forwards detectDuplicates → reported collision hard-rejects at 11.5", async () => {
    const audit = new InMemoryAuditEmitter();
    const pool = corePool();
    const duplicateCalls: Array<{ counterpartyId: string; amount: string }> = [];
    const service = new PaymentIntentService({
      pool,
      audit,
      outbox: new OutboxService(),
      approvals: new ApprovalService({ pool, audit, resolveRole: async () => null }),
      resolveAgent: async () => GATE_AGENT,
      resolveAccount: async () => GATE_ACCOUNT,
      resolveCounterparty: async () => GATE_CP,
      evaluatePolicy: async () => POLICY_DECISION,
      resolvePrincipal: async () => GATE_PRINCIPAL,
      detectDuplicates: async (_ctx, input) => {
        duplicateCalls.push({
          counterpartyId: input.paymentIntent.counterpartyId,
          amount: input.paymentIntent.amount,
        });
        return {
          passed: false,
          collisions: [
            {
              rule: "vendor_amount_invoice_match",
              detail: "same counterparty+amount executed within 30 days",
              conflicting_payment_intent_id: "pi_prior",
            },
          ],
        };
      },
    });

    await expect(service.execute(ctx, PI_ID)).rejects.toMatchObject({
      code: "payment_intent_gate_failed",
    });
    expect(duplicateCalls).toEqual([{ counterpartyId: CP_ID, amount: "100.00" }]);
  });
});
