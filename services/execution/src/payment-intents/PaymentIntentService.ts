/**
 * PaymentIntentService — implementation of IPaymentIntentService.
 *
 * Owns the §9.5 PaymentIntent lifecycle and is the only path that drives
 * a PaymentIntent from `approved` → `executed`. Execution is gated by
 * `runPreExecutionGate` (§6); audit-before / audit-after pair is
 * emitted around the rail dispatch.
 *
 * Layer note. The PaymentIntent row lives in the Ledger table
 * `ledger_payment_intents`; this service mutates it via the typed
 * helpers exported from `@brain/ledger`. The "every service owns its
 * schema" rule (§2 of standards) is preserved because the SQL stays
 * inside services/ledger; services/execution only calls the typed
 * helpers.
 */

import {
  brainError,
  newExecutionId,
  newPaymentIntentId,
  withTenantScope,
  type AuditEmitter,
  type CreatePaymentIntentInput,
  type ExecuteResult,
  type IPaymentIntentService,
  type PaymentIntent,
  type PaymentIntentStatus,
  type ServiceCallContext,
  runPreExecutionGate,
  type GateAccount,
  type GateAgent,
  type GateCounterparty,
  type GatePaymentIntent,
  type GatePolicyDecision,
  type GatePrincipal,
  type GateResult,
} from "@brain/shared";
import {
  appendApprovalId,
  appendExecutionReceiptId,
  findPaymentIntentById,
  insertPaymentIntent,
  listPaymentIntents,
  transitionPaymentIntent,
  type PaymentIntentRow,
} from "@brain/ledger";
import type { Pool } from "pg";
import { assertPaymentIntentTransition, type PaymentIntentState } from "./state-machine.js";
import type { ApprovalService } from "../approvals/ApprovalService.js";
import { insertExecution, transitionExecution } from "../repository.js";
import type { RailRegistry } from "../rails/stubs.js";

// ---------- Dependency hooks ----------------------------------------------

/**
 * Caller-supplied policy evaluator. For Phase 4 we don't extend
 * IPolicyService to return the gate-rich shape; the implementer of this
 * function (in production wiring, post-stage-8 service-mesh) is
 * responsible for joining the active policy's matched rule into the
 * GatePolicyDecision shape.
 *
 * In tests we inject a fixture directly.
 */
export type PaymentIntentPolicyEvaluator = (
  ctx: ServiceCallContext,
  intent: GatePaymentIntent,
) => Promise<GatePolicyDecision>;

export interface PaymentIntentServiceDeps {
  pool: Pool;
  audit: AuditEmitter;
  rails: RailRegistry;
  approvals: ApprovalService;
  /** Resolves the agent record by id; returns null if missing/inactive. */
  resolveAgent: (ctx: ServiceCallContext, agentId: string) => Promise<GateAgent | null>;
  /** Resolves the source account by id. */
  resolveAccount: (ctx: ServiceCallContext, accountId: string) => Promise<GateAccount | null>;
  /** Resolves the destination counterparty by id. */
  resolveCounterparty: (
    ctx: ServiceCallContext,
    counterpartyId: string,
  ) => Promise<GateCounterparty | null>;
  /** Evaluate policy for the intent — see PaymentIntentPolicyEvaluator. */
  evaluatePolicy: PaymentIntentPolicyEvaluator;
  /** Resolve the principal making the execute call. Pulled from the JWT. */
  resolvePrincipal: (ctx: ServiceCallContext) => Promise<GatePrincipal>;
}

// ---------- Service ------------------------------------------------------

export class PaymentIntentService implements IPaymentIntentService {
  public constructor(private readonly deps: PaymentIntentServiceDeps) {}

  // ---- create ----------------------------------------------------------

  public async create(
    ctx: ServiceCallContext,
    input: CreatePaymentIntentInput,
  ): Promise<PaymentIntent> {
    if (!/^\d+(\.\d+)?$/.test(input.amount) || input.amount === "0") {
      throw brainError("request_body_invalid", "amount must be a positive decimal string");
    }

    // Evaluate policy at creation time so the row carries a fresh
    // PolicyDecision id. Re-evaluation happens at execute() to defend
    // against state changes between propose and execute.
    const stub = stubGateIntent({
      id: "pi_PENDING",
      ownerId: ctx.tenantId,
      input,
    });
    const decision = await this.deps.evaluatePolicy(ctx, stub);

    const status: PaymentIntentStatus =
      decision.outcome === "reject"
        ? "rejected"
        : decision.outcome === "allow"
          ? "approved"
          : "pending_approval";

    const row = await withTenantScope(this.deps.pool, ctx.tenantId, (c) =>
      insertPaymentIntent(c, {
        id: newPaymentIntentId(),
        ownerId: ctx.tenantId,
        createdByAgentId: input.agent_id ?? ctx.actor,
        actionType: input.action_type,
        sourceAccountId: input.source_account_id,
        destinationCounterpartyId: input.destination_counterparty_id,
        amount: input.amount,
        currency: input.currency,
        ...(input.obligation_id !== undefined ? { obligationId: input.obligation_id } : {}),
        ...(input.invoice_id !== undefined ? { invoiceId: input.invoice_id } : {}),
        status,
        policyDecisionId: decision.id,
        evidenceIds: input.evidence_ids ?? [],
      }),
    );

    await this.deps.audit.emit({
      tenantId: ctx.tenantId,
      layer: "agent",
      actor: ctx.actor,
      action: "payment_intent.created",
      inputs: {
        action_type: input.action_type,
        source_account_id: input.source_account_id,
        destination_counterparty_id: input.destination_counterparty_id,
        amount: input.amount,
        currency: input.currency,
      },
      outputs: {
        payment_intent_id: row.id,
        status: row.status,
        policy_decision_id: decision.id,
      },
      policyDecisionId: decision.id,
    });

    return toRecord(row);
  }

  // ---- get/list --------------------------------------------------------

  public async get(ctx: ServiceCallContext, id: string): Promise<PaymentIntent | null> {
    const row = await withTenantScope(this.deps.pool, ctx.tenantId, (c) =>
      findPaymentIntentById(c, id),
    );
    return row === null ? null : toRecord(row);
  }

  public async list(
    ctx: ServiceCallContext,
    f: { status?: PaymentIntentStatus; agent_id?: string; limit?: number },
  ): Promise<PaymentIntent[]> {
    const rows = await withTenantScope(this.deps.pool, ctx.tenantId, (c) =>
      listPaymentIntents(c, {
        ...(f.status !== undefined ? { status: f.status } : {}),
        ...(f.agent_id !== undefined ? { created_by_agent_id: f.agent_id } : {}),
        limit: Math.min(f.limit ?? 50, 500),
      }),
    );
    return rows.map(toRecord);
  }

  // ---- approve / reject / cancel ---------------------------------------

  public async approve(ctx: ServiceCallContext, id: string): Promise<PaymentIntent> {
    const intent = await this.requireIntent(ctx, id);
    if (intent.status !== "pending_approval") {
      throw brainError(
        "payment_intent_invalid_state",
        `cannot approve PaymentIntent in status ${intent.status}`,
      );
    }

    // Record the approval.
    const approval = await this.deps.approvals.sign(ctx, { type: "payment_intent", id });
    await withTenantScope(this.deps.pool, ctx.tenantId, (c) =>
      appendApprovalId(c, id, approval.id),
    );

    // Check whether quorum is met. Required approvers came from the
    // PolicyDecision — re-evaluate so we always check against the current
    // decision (operators may have rotated the policy between creation
    // and approval).
    const fresh = await this.deps.evaluatePolicy(ctx, intentToGate(intent));
    const ready = await this.deps.approvals.hasRequiredApprovals(
      ctx,
      { type: "payment_intent", id },
      fresh.required_approvers,
    );

    if (ready) {
      const updated = await withTenantScope(this.deps.pool, ctx.tenantId, async (c) => {
        assertPaymentIntentTransition("pending_approval", "approved");
        return transitionPaymentIntent(c, id, "pending_approval", "approved");
      });
      if (updated === null) {
        throw brainError(
          "payment_intent_invalid_state",
          "PaymentIntent moved between approve and quorum check",
        );
      }
      await this.deps.audit.emit({
        tenantId: ctx.tenantId,
        layer: "agent",
        actor: ctx.actor,
        action: "payment_intent.approved",
        inputs: { payment_intent_id: id, approval_id: approval.id },
        outputs: { status: "approved", required_approvers: fresh.required_approvers },
        policyDecisionId: fresh.id,
      });
      return toRecord(updated);
    }

    // Quorum not met yet — return the intent unchanged but with the new
    // approval recorded.
    const refetched = await withTenantScope(this.deps.pool, ctx.tenantId, (c) =>
      findPaymentIntentById(c, id),
    );
    return toRecord(refetched!);
  }

  public async reject(
    ctx: ServiceCallContext,
    id: string,
    reason?: string,
  ): Promise<PaymentIntent> {
    const intent = await this.requireIntent(ctx, id);
    if (
      intent.status !== "pending_approval" &&
      intent.status !== "proposed" &&
      intent.status !== "approved"
    ) {
      throw brainError(
        "payment_intent_invalid_state",
        `cannot reject PaymentIntent in status ${intent.status}`,
      );
    }
    assertPaymentIntentTransition(intent.status as PaymentIntentState, "rejected");
    const updated = await withTenantScope(this.deps.pool, ctx.tenantId, (c) =>
      transitionPaymentIntent(c, id, intent.status, "rejected"),
    );
    if (updated === null) {
      throw brainError("payment_intent_invalid_state", "PaymentIntent moved during reject");
    }
    await this.deps.audit.emit({
      tenantId: ctx.tenantId,
      layer: "agent",
      actor: ctx.actor,
      action: "payment_intent.rejected",
      inputs: { payment_intent_id: id, reason: reason ?? null },
      outputs: { status: "rejected" },
    });
    return toRecord(updated);
  }

  public async cancel(ctx: ServiceCallContext, id: string): Promise<PaymentIntent> {
    const intent = await this.requireIntent(ctx, id);
    if (intent.status !== "proposed") {
      throw brainError(
        "payment_intent_invalid_state",
        `cancel only allowed from 'proposed', current=${intent.status}`,
      );
    }
    assertPaymentIntentTransition("proposed", "cancelled");
    const updated = await withTenantScope(this.deps.pool, ctx.tenantId, (c) =>
      transitionPaymentIntent(c, id, "proposed", "cancelled"),
    );
    if (updated === null) {
      throw brainError("payment_intent_invalid_state", "PaymentIntent moved during cancel");
    }
    await this.deps.audit.emit({
      tenantId: ctx.tenantId,
      layer: "agent",
      actor: ctx.actor,
      action: "payment_intent.cancelled",
      inputs: { payment_intent_id: id },
      outputs: { status: "cancelled" },
    });
    return toRecord(updated);
  }

  // ---- execute (the §6 gate path) --------------------------------------

  public async execute(ctx: ServiceCallContext, id: string): Promise<ExecuteResult> {
    const intent = await this.requireIntent(ctx, id);
    if (intent.status !== "approved") {
      throw brainError(
        "payment_intent_invalid_state",
        `execute requires status='approved', current=${intent.status}`,
      );
    }

    const principal = await this.deps.resolvePrincipal(ctx);
    const gateInput = intentToGate(intent);

    const gate: GateResult = await runPreExecutionGate(
      {
        audit: this.deps.audit,
        resolveAgent: (agentId) => this.deps.resolveAgent(ctx, agentId),
        resolveAccount: (accountId) => this.deps.resolveAccount(ctx, accountId),
        resolveCounterparty: (cpId) => this.deps.resolveCounterparty(ctx, cpId),
        evaluatePolicy: (i) => this.deps.evaluatePolicy(ctx, i),
        resolveApprovals: async (intentId) => ({
          signedRoles: await this.deps.approvals.signedRoles(ctx, {
            type: "payment_intent",
            id: intentId,
          }),
        }),
      },
      { ctx, principal, intent: gateInput },
    );

    if (!gate.ok) {
      // Audit-before/after pair: even on gate failure we emit an "after"
      // event with ok:false so the audit trail is symmetric.
      await this.deps.audit.emit({
        tenantId: ctx.tenantId,
        layer: "agent",
        actor: ctx.actor,
        action: "payment_intent.execute.after",
        inputs: { payment_intent_id: id },
        outputs: {
          ok: false,
          failed_check: gate.failedCheck,
          gate_failed: true,
        },
      });
      throw brainError(
        "payment_intent_gate_failed",
        `pre-execution gate failed at check ${gate.failedCheck.index} (${gate.failedCheck.name})`,
        {
          statusOverride: 409,
          details: {
            check_index: gate.failedCheck.index,
            check_name: gate.failedCheck.name,
            ...gate.failedCheck.detail,
          },
        },
      );
    }

    // Gate passed. Dispatch through the rail.
    const railName = railFor(intent.action_type);
    const rail = this.deps.rails.get(railName);
    const executionId = newExecutionId();
    const idempotencyKey = `pi:${intent.id}:${gate.policyDecisionId}`;

    let dispatchOutcome:
      | { ok: true; receipt: Record<string, unknown> }
      | { ok: false; error: Error };
    try {
      const dispatch = await rail.dispatch({
        tenantId: ctx.tenantId,
        proposalId: intent.id,
        executionId,
        action: {
          kind: intent.action_type,
          source_account_id: intent.source_account_id,
          destination_counterparty_id: intent.destination_counterparty_id,
          amount: intent.amount,
          currency: intent.currency,
        },
        idempotencyKey,
      });
      dispatchOutcome = { ok: true, receipt: dispatch.receipt };
    } catch (err) {
      dispatchOutcome = { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
    }

    if (!dispatchOutcome.ok) {
      await withTenantScope(this.deps.pool, ctx.tenantId, async (c) => {
        await transitionPaymentIntent(c, intent.id, "approved", "failed");
      });
      await this.deps.audit.emit({
        tenantId: ctx.tenantId,
        layer: "agent",
        actor: ctx.actor,
        action: "payment_intent.execute.after",
        inputs: { payment_intent_id: id, rail: railName, execution_id: executionId },
        outputs: { ok: false, error: dispatchOutcome.error.message },
        policyDecisionId: gate.policyDecisionId,
      });
      throw brainError("agent_rail_unavailable", "rail dispatch failed", {
        cause: dispatchOutcome.error,
      });
    }

    // Persist the execution row, link it to the PaymentIntent, transition.
    await withTenantScope(this.deps.pool, ctx.tenantId, async (c) => {
      await insertExecution(c, {
        id: executionId,
        tenantId: ctx.tenantId,
        proposalId: intent.id,
        rail: railName,
        status: "dispatched",
        idempotencyKey,
      });
      await transitionExecution(c, executionId, "dispatched", "in_flight");
      await transitionPaymentIntent(c, intent.id, "approved", "executed");
      await appendExecutionReceiptId(c, intent.id, executionId);
    });

    await this.deps.audit.emit({
      tenantId: ctx.tenantId,
      layer: "agent",
      actor: ctx.actor,
      action: "payment_intent.execute.after",
      inputs: { payment_intent_id: id, rail: railName, execution_id: executionId },
      outputs: {
        ok: true,
        rail_receipt: dispatchOutcome.receipt,
        gate_audit_before: gate.auditBeforeEventId,
      },
      policyDecisionId: gate.policyDecisionId,
    });

    return {
      payment_intent_id: intent.id,
      execution_id: executionId,
      rail: railName,
      status: "in_flight",
    };
  }

  // ---- internals -------------------------------------------------------

  private async requireIntent(ctx: ServiceCallContext, id: string): Promise<PaymentIntentRow> {
    const row = await withTenantScope(this.deps.pool, ctx.tenantId, (c) =>
      findPaymentIntentById(c, id),
    );
    if (row === null) {
      throw brainError("payment_intent_not_found", "no such PaymentIntent", {
        details: { id },
      });
    }
    return row;
  }
}

// ---------- helpers -------------------------------------------------------

function railFor(actionType: string): string {
  switch (actionType) {
    case "ach_outbound":
    case "ach_inbound":
    case "wire":
    case "card_payment":
      return "bank_ach";
    case "onchain_transfer":
      return "onchain_base";
    case "erp_writeback":
      return "erp_writeback";
    default:
      return "bank_ach";
  }
}

function intentToGate(row: PaymentIntentRow): GatePaymentIntent {
  return {
    id: row.id,
    owner_id: row.owner_id,
    created_by_agent_id: row.created_by_agent_id,
    action_type: row.action_type,
    source_account_id: row.source_account_id,
    destination_counterparty_id: row.destination_counterparty_id,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    policy_decision_id: row.policy_decision_id,
    evidence_ids: row.evidence_ids,
  };
}

function stubGateIntent(args: {
  id: string;
  ownerId: string;
  input: CreatePaymentIntentInput;
}): GatePaymentIntent {
  return {
    id: args.id,
    owner_id: args.ownerId,
    created_by_agent_id: args.input.agent_id ?? null,
    action_type: args.input.action_type,
    source_account_id: args.input.source_account_id,
    destination_counterparty_id: args.input.destination_counterparty_id,
    amount: args.input.amount,
    currency: args.input.currency,
    status: "proposed",
    policy_decision_id: null,
    evidence_ids: args.input.evidence_ids ?? [],
  };
}

function toRecord(row: PaymentIntentRow): PaymentIntent {
  return {
    id: row.id,
    owner_id: row.owner_id,
    source_ids: row.source_ids,
    evidence_ids: row.evidence_ids,
    provenance: row.provenance as PaymentIntent["provenance"],
    confidence: row.confidence,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    created_by_agent_id: row.created_by_agent_id,
    action_type: row.action_type as PaymentIntent["action_type"],
    source_account_id: row.source_account_id,
    destination_counterparty_id: row.destination_counterparty_id,
    amount: row.amount,
    currency: row.currency,
    obligation_id: row.obligation_id,
    invoice_id: row.invoice_id,
    status: row.status as PaymentIntent["status"],
    policy_decision_id: row.policy_decision_id,
    approval_ids: row.approval_ids,
    execution_receipt_ids: row.execution_receipt_ids,
  };
}
