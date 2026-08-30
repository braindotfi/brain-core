import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  computeServiceAuthSignatureV2,
  InMemoryAuditEmitter,
  type GateAccount,
  type GateAgent,
  type GateCounterparty,
  type GatePolicyDecision,
  type GatePrincipal,
} from "@brain/shared";
import type { PaymentIntentRow } from "@brain/ledger";
import { ApprovalService, OutboxService, PaymentIntentService } from "@brain/execution";
import type { ActorResolver } from "@brain/execution";
import { registerSurfaceActionHandoffRoutes } from "./routes.js";

const SECRET = "surface-action-test-secret";
const TENANT_ID = "tnt_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PROPOSAL_ID = "prop_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PAYMENT_INTENT_ID = "pi_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const MEMBER_ID = "user_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const AGENT_ID = "agent_01ARZ3NDEKTSV4RRFFQ69G5FAV";

describe("surface action handoff", () => {
  it("routes a linked approval and execution through the canonical payment service", async () => {
    const approve = vi.fn().mockResolvedValue(paymentIntent("approved"));
    const execute = vi.fn().mockResolvedValue({
      payment_intent_id: PAYMENT_INTENT_ID,
      execution_id: null,
      outbox_id: "exo_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      rail: "bank_ach",
      status: "dispatching",
    });
    const get = vi
      .fn()
      .mockResolvedValueOnce(paymentIntent("pending_approval"))
      .mockResolvedValueOnce(paymentIntent("approved"));
    const app = Fastify();
    await registerSurfaceActionHandoffRoutes(app, {
      pool: {} as Pool,
      paymentIntents: { approve, execute, get } as unknown as PaymentIntentService,
      approvals: {
        list: vi.fn().mockResolvedValue([]),
      } as unknown as ApprovalService,
      actorResolver: {
        resolve: vi.fn().mockResolvedValue({ memberId: MEMBER_ID }),
      } as unknown as ActorResolver,
      signingSecret: SECRET,
    });

    const approval = await app.inject(signedRequest("approve"));
    expect(approval.statusCode).toBe(200);
    expect(approval.json()).toEqual({ status: "approved", quorum_met: true });
    expect(approve).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT_ID, principalType: "api_partner" }),
      PAYMENT_INTENT_ID,
      {
        surfaceIdentity: { surface: "slack", externalRef: "U123" },
      },
    );

    const execution = await app.inject(signedRequest("execute"));
    expect(execution.statusCode).toBe(202);
    expect(execution.json()).toEqual({
      status: "dispatching",
      outbox_id: "exo_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    });
    expect(execute).toHaveBeenCalledWith(
      {
        tenantId: TENANT_ID,
        actor: AGENT_ID,
        principalType: "agent",
        scopes: ["payment_intent:execute"],
        requestId: `surface:${PROPOSAL_ID}`,
      },
      PAYMENT_INTENT_ID,
    );
    await app.close();
  });

  it("rejects an unsigned handoff before reading tenant data", async () => {
    const get = vi.fn();
    const app = Fastify();
    await registerSurfaceActionHandoffRoutes(app, {
      pool: {} as Pool,
      paymentIntents: { get } as unknown as PaymentIntentService,
      approvals: {} as ApprovalService,
      actorResolver: {} as ActorResolver,
      signingSecret: SECRET,
    });
    const response = await app.inject({
      method: "POST",
      url: "/internal/surface-actions/approve",
      payload: requestBody(),
    });
    expect(response.statusCode).toBe(401);
    expect(get).not.toHaveBeenCalled();
    await app.close();
  });

  it("takes an accepted surface decision through the real section 6 gate and outbox write", async () => {
    const audit = new InMemoryAuditEmitter();
    const outboxWrites: unknown[][] = [];
    const approved = approvedPaymentIntentRow();
    const pool = fakeExecutionPool((sql, values) => {
      if (sql.includes("FROM ledger_payment_intents WHERE id")) {
        return { rows: [approved], rowCount: 1 };
      }
      if (sql.includes("UPDATE ledger_payment_intents")) {
        return { rows: [{ ...approved, status: "dispatching" }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO ledger_reservations")) {
        return { rows: [{ id: values[0] }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO execution_outbox")) {
        outboxWrites.push(values);
        return { rows: [{ id: "exo_01ARZ3NDEKTSV4RRFFQ69G5FAV" }], rowCount: 1 };
      }
      if (sql.includes("approval_ids")) {
        return { rows: [approved], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const canonical = canonicalPaymentIntentService(pool, audit);
    const get = vi
      .fn()
      .mockResolvedValueOnce(paymentIntent("pending_approval"))
      .mockResolvedValueOnce(paymentIntent("approved"));
    const app = Fastify();
    await registerSurfaceActionHandoffRoutes(app, {
      pool,
      paymentIntents: {
        get,
        approve: vi.fn().mockResolvedValue(paymentIntent("approved")),
        execute: canonical.execute.bind(canonical),
      } as unknown as PaymentIntentService,
      approvals: { list: vi.fn().mockResolvedValue([]) } as unknown as ApprovalService,
      actorResolver: {
        resolve: vi.fn().mockResolvedValue({ memberId: MEMBER_ID }),
      } as unknown as ActorResolver,
      signingSecret: SECRET,
    });

    expect((await app.inject(signedRequest("approve"))).statusCode).toBe(200);
    const execution = await app.inject(signedRequest("execute"));

    expect(execution.statusCode).toBe(202);
    expect(execution.json()).toMatchObject({
      status: "dispatching",
      outbox_id: "exo_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    });
    expect(outboxWrites).toHaveLength(1);
    expect(audit.events.map((event) => event.action)).toEqual(
      expect.arrayContaining(["payment_intent.execute.before", "payment_intent.execute.enqueued"]),
    );
    await app.close();
  });
});

function signedRequest(operation: "approve" | "execute") {
  const body = JSON.stringify(requestBody());
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    method: "POST" as const,
    url: `/internal/surface-actions/${operation}`,
    headers: {
      "content-type": "application/json",
      "x-brain-service-timestamp": timestamp,
      "x-brain-write-tenant": TENANT_ID,
      "x-brain-service-auth": computeServiceAuthSignatureV2(
        SECRET,
        timestamp,
        TENANT_ID,
        Buffer.from(body),
      ),
    },
    payload: body,
  };
}

function requestBody() {
  return {
    tenant_id: TENANT_ID,
    proposal_id: PROPOSAL_ID,
    payment_intent_id: PAYMENT_INTENT_ID,
    surface: "slack",
    external_actor_id: "U123",
  };
}

function paymentIntent(status: "pending_approval" | "approved") {
  return {
    id: PAYMENT_INTENT_ID,
    owner_id: TENANT_ID,
    created_by_agent_id: AGENT_ID,
    status,
  };
}

function approvedPaymentIntentRow(): PaymentIntentRow {
  return {
    id: PAYMENT_INTENT_ID,
    owner_id: TENANT_ID,
    created_by_agent_id: AGENT_ID,
    action_type: "ach_outbound",
    source_account_id: "acct_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    destination_counterparty_id: "cp_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    amount: "100.00",
    currency: "USD",
    obligation_id: null,
    invoice_id: null,
    proposal_dedup_key: null,
    settlement_pay_to: null,
    escrow_id: null,
    job_terms_hash: null,
    status: "approved",
    policy_decision_id: "pd_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    approval_ids: [],
    execution_receipt_ids: [],
    source_ids: [],
    evidence_ids: [],
    provenance: "surface_regression",
    confidence: 1,
    evidence_score: null,
    risk_level: null,
    created_at: new Date("2026-08-30T00:00:00Z"),
    updated_at: new Date("2026-08-30T00:00:00Z"),
  };
}

function canonicalPaymentIntentService(
  pool: Pool,
  audit: InMemoryAuditEmitter,
): PaymentIntentService {
  const agent: GateAgent = {
    id: AGENT_ID,
    state: "active",
    scope: { canExecutePayments: true },
  };
  const account: GateAccount = {
    id: "acct_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    status: "active",
    currency: "USD",
    available_balance: "5000.00",
  };
  const counterparty: GateCounterparty = {
    id: "cp_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    type: "vendor",
    risk_level: "low",
    verified_status: "document_verified",
  };
  const principal: GatePrincipal = {
    id: AGENT_ID,
    type: "agent",
    scopes: ["payment_intent:execute"],
  };
  const policy: GatePolicyDecision = {
    id: "pd_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    outcome: "allow",
    matched_rule_id: "surface-regression",
    required_approvers: [],
    ledger_snapshot_hash: "surface-regression-snapshot",
    trace: [],
    required_evidence_kinds: [],
    counterparty_verification_threshold: null,
    amount_upper_bound: null,
    ach_autonomous_max_amount: { currency: "USD", value: "1000.00" },
  };
  return new PaymentIntentService({
    pool,
    audit,
    outbox: new OutboxService(),
    approvals: new ApprovalService({ pool, audit, resolveRole: async () => null }),
    resolveAgent: async () => agent,
    resolveAccount: async () => account,
    resolveCounterparty: async () => counterparty,
    evaluatePolicy: async () => policy,
    resolvePrincipal: async () => principal,
  });
}

function fakeExecutionPool(
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
      const handled = queryFn(sql, values ?? []);
      if (handled.rows.length > 0 || handled.rowCount > 0) return Promise.resolve(handled);
      if (sql.includes("FROM ledger_accounts") && sql.includes("FOR UPDATE")) {
        return Promise.resolve({
          rows: [
            {
              id: values?.[0],
              status: "active",
              currency: "USD",
              available_balance: "5000.00",
            },
          ],
          rowCount: 1,
        });
      }
      if (sql.includes("FROM ledger_balances") && sql.includes("FOR UPDATE")) {
        return Promise.resolve({
          rows: [{ currency: "USD", available_balance: "5000.00" }],
          rowCount: 1,
        });
      }
      if (sql.includes("FROM ledger_reservations") && sql.includes("COALESCE(SUM(amount)")) {
        return Promise.resolve({ rows: [{ total: "0" }], rowCount: 1 });
      }
      return Promise.resolve(handled);
    }),
    release: vi.fn(),
  };
  return { connect: vi.fn(() => Promise.resolve(client)) } as unknown as Pool;
}
