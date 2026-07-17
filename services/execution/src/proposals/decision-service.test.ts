import { describe, expect, it, vi } from "vitest";
import {
  brainError,
  newAgentId,
  newAuditEventId,
  newPaymentIntentId,
  newProposalId,
  newTenantId,
  newUserId,
  type AuditEmitter,
  type PaymentIntent,
  type ServiceCallContext,
} from "@brain/shared";
import type { Pool } from "pg";
import type { ActorResolver } from "../members/ActorResolver.js";
import type { ActorContext } from "../members/types.js";
import type { PaymentIntentService } from "../payment-intents/PaymentIntentService.js";
import type { ProposalRow } from "../repository.js";
import { ProposalDecisionService } from "./decision-service.js";

const TENANT = newTenantId();
const MEMBER = newUserId();
const AGENT = newAgentId();
const PROPOSAL = newProposalId();
const PAYMENT_INTENT = newPaymentIntentId();

function ctx(input: Partial<ServiceCallContext> = {}): ServiceCallContext {
  return {
    tenantId: TENANT,
    actor: MEMBER,
    principalType: "user",
    scopes: ["execution:read", "payment_intent:approve"],
    ...input,
  };
}

function proposal(overrides: Partial<ProposalRow> = {}): ProposalRow {
  return {
    id: PROPOSAL,
    tenant_id: TENANT,
    proposing_agent: AGENT,
    action: { type: "vendor_risk" },
    policy_version: 1,
    policy_decision: "confirm",
    policy_trace: [],
    required_approvers: [],
    status: "pending",
    approvers_signed: [],
    proposal_dedup_key: null,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("ProposalDecisionService", () => {
  it("emits proposal.decided before transitioning an agent proposal", async () => {
    const order: string[] = [];
    const row = proposal({ action: { type: "vendor_risk", mode: "notify_only" } });
    const service = serviceFor(row, { order });

    const result = await service.decide(ctx(), PROPOSAL, "acknowledge");

    expect(result).toMatchObject({ id: PROPOSAL, status: "acknowledged", audit_id: "evt_1" });
    expect(order).toEqual(["audit", "transition"]);
    expect(row.status).toBe("acknowledged");
  });

  it("denies an unresolved user before auditing or transitioning", async () => {
    const order: string[] = [];
    const row = proposal();
    const service = serviceFor(row, { order, actor: null });

    await expect(service.decide(ctx(), PROPOSAL, "approve")).rejects.toMatchObject({
      code: "payment_intent_approval_invalid",
    });
    expect(order).toEqual([]);
    expect(row.status).toBe("pending");
  });

  it("denies agent principals at the identity layer", async () => {
    const row = proposal();
    const service = serviceFor(row);

    await expect(
      service.decide(ctx({ actor: AGENT, principalType: "agent" }), PROPOSAL, "approve"),
    ).rejects.toMatchObject({ code: "payment_intent_approval_invalid" });
    expect(row.status).toBe("pending");
  });

  it("does not re-audit a repeated terminal acknowledgement", async () => {
    const order: string[] = [];
    const row = proposal({ action: { type: "vendor_risk", mode: "notify_only" } });
    const service = serviceFor(row, { order });

    const first = await service.decide(ctx(), PROPOSAL, "acknowledge");
    const second = await service.decide(ctx(), PROPOSAL, "acknowledge");

    expect(first.audit_id).toBe("evt_1");
    expect(second.audit_id).toBe("evt_1");
    expect(order).toEqual(["audit", "transition"]);
    expect(row.status).toBe("acknowledged");
  });

  it("rejects undo after a proposal executed", async () => {
    const row = proposal({ status: "executed" });
    const service = serviceFor(row);

    await expect(service.decide(ctx(), PROPOSAL, "undo")).rejects.toMatchObject({
      code: "execution_proposal_invalid_state",
    });
    expect(row.status).toBe("executed");
  });

  it("routes money-path approval through PaymentIntentService and returns awaiting_second_approval", async () => {
    const approve = vi.fn(async () => paymentIntent("awaiting_second_approval"));
    const row = proposal({ id: PAYMENT_INTENT, status: "pending" });
    const service = serviceFor(row, {
      paymentIntentId: PAYMENT_INTENT,
      paymentIntents: { approve } as unknown as PaymentIntentService,
    });

    const result = await service.decide(ctx(), PAYMENT_INTENT, "approve");

    expect(approve).toHaveBeenCalledWith(
      expect.objectContaining({ actor: MEMBER }),
      PAYMENT_INTENT,
    );
    expect(result).toMatchObject({
      id: PAYMENT_INTENT,
      status: "awaiting_second_approval",
      payment_intent_id: PAYMENT_INTENT,
    });
  });
});

function serviceFor(
  row: ProposalRow,
  options: {
    order?: string[];
    actor?: ActorContext | null;
    paymentIntentId?: string | null;
    paymentIntents?: Partial<PaymentIntentService>;
  } = {},
): ProposalDecisionService {
  const auditRows: Array<{ id: string; idempotencyKey: string }> = [];
  const order = options.order ?? [];
  const pool = fakePool(row, auditRows, order, options.paymentIntentId ?? null);
  const actorResolver = {
    resolve: async (input: { ctx: ServiceCallContext }) => {
      if (input.ctx.principalType !== "user") {
        throw brainError("payment_intent_approval_invalid", "actor_unresolved", {
          statusOverride: 403,
          details: { reason: "actor_unresolved" },
        });
      }
      if (options.actor === null) {
        throw brainError("payment_intent_approval_invalid", "actor_unresolved", {
          statusOverride: 403,
          details: { reason: "actor_unresolved" },
        });
      }
      return (
        options.actor ?? {
          memberId: MEMBER,
          email: "member@example.com",
          verification: "session",
        }
      );
    },
  } as unknown as ActorResolver;
  const audit: AuditEmitter = {
    emit: vi.fn(async (event) => {
      order.push("audit");
      const existing = auditRows.find((row) => row.idempotencyKey === event.idempotencyKey);
      if (existing !== undefined) {
        return {
          ...event,
          id: existing.id,
          eventHash: "hash",
          prevEventHash: null,
          createdAt: new Date().toISOString(),
        };
      }
      const id = auditRows.length === 0 ? "evt_1" : newAuditEventId();
      auditRows.push({ id, idempotencyKey: event.idempotencyKey ?? "" });
      return {
        ...event,
        id,
        eventHash: "hash",
        prevEventHash: null,
        createdAt: new Date().toISOString(),
      };
    }),
  };
  return new ProposalDecisionService({
    pool,
    audit,
    actorResolver,
    paymentIntents:
      (options.paymentIntents as PaymentIntentService | undefined) ??
      ({
        approve: vi.fn(async () => paymentIntent("approved")),
        reject: vi.fn(async () => paymentIntent("rejected")),
      } as unknown as PaymentIntentService),
  });
}

function fakePool(
  proposal: ProposalRow,
  auditRows: Array<{ id: string; idempotencyKey: string }>,
  order: string[],
  paymentIntentId: string | null,
): Pool {
  let tenant: string | null = null;
  const client = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (sql.startsWith("SELECT set_config")) {
        tenant = values[0] as string;
        return { rows: [], rowCount: 0 };
      }
      if (tenant !== TENANT) throw new Error("tenant scope was not set");
      if (sql.includes("SELECT id FROM wiki_entities")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("WITH unified AS")) {
        return { rows: [rawProposalRow(proposal, paymentIntentId)], rowCount: 1 };
      }
      if (sql.includes("FROM proposals") && sql.includes("FOR UPDATE")) {
        return { rows: [proposal], rowCount: 1 };
      }
      if (sql.includes("SELECT id") && sql.includes("FROM audit_events")) {
        const prefix = String(values[0]);
        const row = auditRows.find((candidate) => candidate.idempotencyKey.startsWith(prefix));
        return {
          rows: row === undefined ? [] : [{ id: row.id }],
          rowCount: row === undefined ? 0 : 1,
        };
      }
      if (sql.includes("UPDATE proposals")) {
        order.push("transition");
        proposal.status = values[0] as ProposalRow["status"];
        return { rows: [proposal], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };
  return { connect: async () => client } as unknown as Pool;
}

function rawProposalRow(row: ProposalRow, paymentIntentId: string | null): Record<string, unknown> {
  return {
    id: row.id,
    source_kind: paymentIntentId === null ? "proposal" : "payment_intent",
    type: paymentIntentId === null ? row.action["type"] : "payment",
    created_at: row.created_at,
    status: row.status,
    risk_band: null,
    confidence: null,
    mode: row.action["mode"] === "notify_only" ? "notify_only" : "propose",
    narrative: null,
    action: paymentIntentId === null ? row.action : null,
    evidence_ids: [],
    agent_id: AGENT,
    agent_kind: "internal",
    agent_display_name: "Agent",
    payment_intent_id: paymentIntentId,
    action_type: paymentIntentId === null ? null : "ach_outbound",
  };
}

function paymentIntent(status: PaymentIntent["status"]): PaymentIntent {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: PAYMENT_INTENT,
    owner_id: TENANT,
    created_by_agent_id: AGENT,
    action_type: "ach_outbound",
    source_account_id: "acct_01TEST0000000000000000000",
    destination_counterparty_id: "cp_01TEST00000000000000000000",
    amount: "10.00",
    currency: "USD",
    obligation_id: null,
    invoice_id: null,
    status,
    policy_decision_id: "pd_01TEST00000000000000000000",
    approval_ids: [],
    execution_receipt_ids: [],
    source_ids: [],
    evidence_ids: [],
    provenance: "agent_contributed",
    confidence: 0.91,
    created_at: now,
    updated_at: now,
  };
}
