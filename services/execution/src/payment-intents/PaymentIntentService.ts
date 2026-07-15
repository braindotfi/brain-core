/**
 * PaymentIntentService — implementation of IPaymentIntentService.
 *
 * Owns the §9.5 PaymentIntent lifecycle and is the only path that drives
 * a PaymentIntent from `approved` → `executed`. Execution is gated by
 * `runPreExecutionGate` (§6); audit-before / audit-after pair is
 * emitted around the rail dispatch.
 *
 * Layer note. The PaymentIntent row lives in the Ledger table
 * `ledger_payment_intents`; this service mutates it ONLY through the
 * `LedgerPaymentIntents` facade from `@brain/ledger` (a no-restricted-imports
 * rule blocks the raw repository helpers). The "every service owns its schema"
 * rule (§2 of standards) is preserved because the SQL stays inside
 * services/ledger; services/execution reaches it through one narrow surface.
 */

import {
  brainError,
  isBrainError,
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
  requiresHardHumanApprovalFloor,
  type GateAccount,
  type GateAgent,
  type GateCounterparty,
  type GateDependencies,
  type GatePaymentIntent,
  type GatePolicyDecision,
  type GatePrincipal,
  type GateResult,
  type GateTenantFlags,
  type AgentAttestationInput,
  type AgentAttestationResult,
  type EscrowStateInput,
  type ResolvedEscrowState,
  type ResolvedEvidence,
  type DuplicateCheckInput,
  type DuplicateCheckResult,
  type MetricsEmitter,
  emitDomainEvent,
  newLedgerReservationId,
  type RoutingEnqueue,
  type TenantScopedClient,
} from "@brain/shared";
import { LedgerPaymentIntents, LedgerReservations, type PaymentIntentRow } from "@brain/ledger";
import type { Pool } from "pg";
import { assertPaymentIntentTransition, type PaymentIntentState } from "./state-machine.js";
import type { ApprovalService } from "../approvals/ApprovalService.js";
import {
  insertExecution,
  transitionExecution,
  setExecutionReceipt,
  findExecution,
  type ExecutionRow,
} from "../repository.js";
import type { OutboxService } from "../outbox/OutboxService.js";
import type { ActorResolver } from "../members/ActorResolver.js";
import {
  authorizeApproval,
  decimalAmountToCents,
  paymentIntentApprovalDomain,
  paymentIntentPayeeKind,
  type ApprovalRejectionReason,
} from "../members/authorizeApproval.js";
import type { ActorContext, MemberLookup } from "../members/types.js";

const EXECUTION_RESERVATION_TTL_MS = 24 * 60 * 60 * 1000;

function requiresExecutionReservation(actionType: string): boolean {
  return actionType !== "x402_settle" && actionType !== "escrow_release";
}

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
  /**
   * H-04: execute no longer dispatches the rail synchronously — it enqueues a
   * durable outbox row (atomic with approved → dispatching) and the outbox
   * worker dispatches + settles. The RailRegistry now lives in the worker, not
   * here; the §6 gate-bypass guard enforces that no rail dispatch happens in
   * this file.
   */
  outbox: OutboxService;
  approvals: ApprovalService;
  /** Resolves the authenticated/request actor into a tenant member. */
  actorResolver?: ActorResolver;
  /** Reads member authority for approval authorization. */
  members?: MemberLookup;
  /**
   * Best-effort payee identity resolver for ACTOR != PAYEE. v1 uses the
   * counterparty email fallback because richer employee/vendor identity mapping
   * is not consistently available in the Ledger yet.
   */
  resolveApprovalPayeeEmail?: (
    ctx: ServiceCallContext,
    intent: GatePaymentIntent,
  ) => Promise<string | null>;
  /** Resolves the agent record by id; returns null if missing/inactive. */
  resolveAgent: (ctx: ServiceCallContext, agentId: string) => Promise<GateAgent | null>;
  /**
   * Resolves per-tenant gate-enforcement flags for §6 check 1.5 (P0.1).
   * Optional — absent ⇒ check 1.5 keeps pre-P0.1 behavior.
   */
  resolveTenantFlags?: (ctx: ServiceCallContext, tenantId: string) => Promise<GateTenantFlags>;
  /**
   * Optional: attestation read for an agent payee — §6 gate check 5.5 (RFC 0001
   * §6.3). When wired, the gate hard-rejects a settlement to a non-attested /
   * paused agent counterparty. Absent ⇒ check 5.5 is dormant (no row), so the
   * canonical path is unchanged. The concrete reader (on-chain
   * BrainMCPAgentRegistry membership + pause) is the deferred live-wiring step,
   * injected at boot — mirroring how the real rails' SDK construction is wired.
   * Membership + pause read, never reputation (Standards §6, Principle #5).
   */
  attestCounterpartyAgent?: (
    ctx: ServiceCallContext,
    input: AgentAttestationInput,
  ) => Promise<AgentAttestationResult>;
  /**
   * Optional: an agent's settled spend over a trailing window (decimal string) —
   * §6 gate check 8.5 micropayment cumulative cap (RFC 0001 §6.4). Active only
   * when the policy envelope also carries a `micropayment_window_cap`; absent ⇒
   * check 8.5 is dormant. The concrete windowed-spend query is deferred
   * live-wiring, injected at boot.
   */
  sumAgentWindowSpend?: (
    ctx: ServiceCallContext,
    agentId: string,
    windowSeconds: number,
  ) => Promise<string>;
  /**
   * Optional: reads the on-chain BrainEscrow lock — §6 gate check 6.6
   * (escrow-state binding, RFC 0001 §7.6). When wired, the gate hard-rejects an
   * escrow_release whose on-chain lock does not match the intent (state / amount
   * / payee / job-terms). Absent ⇒ check 6.6 is dormant (no row). The concrete
   * on-chain reader (BrainEscrow.getEscrow via viem) is the deferred live-wiring
   * step, injected at boot — mirroring the real rails' SDK construction.
   */
  resolveEscrowState?: (
    ctx: ServiceCallContext,
    input: EscrowStateInput,
  ) => Promise<ResolvedEscrowState | null>;
  /**
   * §6 gate check 8: sum of active (not-yet-applied) reservations on the
   * source account. The gate subtracts this from `available_balance` so a
   * concurrent intent cannot double-spend committed but un-applied funds.
   * Absent ⇒ check 8 records `not_applicable`; for live money the loader
   * is mandatory.
   */
  sumActiveReservations?: (ctx: ServiceCallContext, accountId: string) => Promise<string>;
  /**
   * §6 gate check 9.5 (H-21): resolves the evidence semantically against
   * the policy's `required_evidence_kinds`. Absent ⇒ check 9.5 records
   * `not_applicable`; for live money the loader is mandatory.
   */
  resolveEvidence?: (
    ctx: ServiceCallContext,
    intent: GatePaymentIntent,
  ) => Promise<ResolvedEvidence[]>;
  /**
   * §6 gate check 11.5 (H-22): duplicate-payment / fraud-pattern detector.
   * Returns collisions per rule (invoice already paid, vendor account swap,
   * etc.). Absent ⇒ check 11.5 records `not_applicable`; for live money
   * the loader is mandatory.
   */
  detectDuplicates?: (
    ctx: ServiceCallContext,
    input: DuplicateCheckInput,
  ) => Promise<DuplicateCheckResult>;
  /**
   * Optional (RFC 0004 §5.2): resolve the confidence of the Ledger obligation an
   * intent is created against. When wired and the intent references an
   * obligation, the intent's confidence is capped at the obligation's, so a
   * payment proposed against a low-confidence (e.g. document-extracted, <= 0.5)
   * obligation inherits that confidence and a tenant `agent.confidence.gte`
   * policy can gate it. Absent ⇒ confidence falls back to the explicit input
   * (or the 1.0 default), preserving prior behavior.
   */
  resolveObligationConfidence?: (
    ctx: ServiceCallContext,
    obligationId: string,
  ) => Promise<number | null>;
  /**
   * §6 gate check 6.7 (batch 10 H-1): reads the linked obligation's
   * direction (`payable` | `receivable` | null). When wired and the intent
   * references an obligation whose direction is `receivable`, the gate hard-
   * rejects the intent. `payable` / null / absent loader ⇒ no rejection. The
   * concrete reader is wired in main.ts via the ledger service.
   */
  resolveObligationDirection?: (
    ctx: ServiceCallContext,
    obligationId: string,
  ) => Promise<"payable" | "receivable" | null>;
  /**
   * Phase 2 trust contract: reads the linked obligation's provenance for the
   * gate's low-trust auto-execution rule (check 9.5). A corroborated
   * obligation (promoted to `extracted`) keeps document-only evidence
   * eligible for an `allow` outcome.
   */
  resolveObligationProvenance?: (
    ctx: ServiceCallContext,
    obligationId: string,
  ) => Promise<string | null>;
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
  /**
   * Optional: resolve on-chain dispatch params for `onchain_transfer` intents.
   * When present, the resolved params are merged into the outbox payload before
   * enqueue. When absent, on-chain intents are enqueued with human-readable
   * fields only (the rail will reject them at dispatch time).
   */
  resolveOnchainParams?: (
    ctx: ServiceCallContext,
    intent: {
      source_account_id: string;
      destination_counterparty_id: string;
      amount: string;
      currency: string;
    },
  ) => Promise<OnchainDispatchParams | null>;
  /**
   * Optional: resolve per-source encrypted credentials for ACH intents.
   * Credentials are merged into the outbox payload (after the gate; never in
   * the gate trace or audit-before/after). Only injected for rails that need
   * provider secrets (e.g. Plaid access_token). Never logs or emits credentials.
   */
  sourceCredentialResolver?: {
    resolve(
      ctx: ServiceCallContext,
      sourceAccountId: string,
    ): Promise<{ credentials: object; source_type: string } | null>;
  };
  /**
   * Optional: metrics sink forwarded into the §6 gate (item 11). When wired the
   * gate emits brain.gate.check.count, brain.gate.outcome.count, and
   * brain.gate.duration_ms on every evaluation. Absent ⇒ no emission.
   */
  metrics?: MetricsEmitter;
  /**
   * Optional: routing enqueue for agent-router domain events (Phase 1). When
   * wired, a rejected payment emits `payment.failed` so the router can route to
   * the collections agent. Absent ⇒ no event is emitted (pre-wiring behavior).
   * Routing is advisory and never gates the financial operation.
   */
  enqueue?: RoutingEnqueue;
  /**
   * Optional: accumulate the agent's spend/tx-count counters for the windows
   * the active policy references (R-21). Called inside completeExecution's
   * transaction on the LIVE settle path only (an intent reaching `executed`),
   * so the counter the gate/VM reads back via `agent.spend_in_window` /
   * `agent.tx_count_in_window` reflects actually-settled spend and commits
   * atomically with the `executed` transition. Absent ⇒ counters never
   * accumulate (the pre-R-21 behaviour: aggregate spend caps read 0). The
   * writer lives in the Policy layer (single source of window truth) and runs
   * on the caller's tenant-scoped client.
   */
  recordAgentSpend?: (
    client: TenantScopedClient,
    input: { tenantId: string; agentId: string; amount: string; currency: string },
  ) => Promise<void>;
}

/** On-chain dispatch params merged into the outbox payload by PaymentIntentService.execute. */
export interface OnchainDispatchParams {
  smart_account: string;
  holder: string;
  target: string;
  data: string;
  value: string;
  policy_version: string;
}

// ---------- Service ------------------------------------------------------

export class PaymentIntentService implements IPaymentIntentService {
  public constructor(private readonly deps: PaymentIntentServiceDeps) {}

  // ---- create ----------------------------------------------------------

  /**
   * Effective confidence for a new intent (RFC 0004 §5.2): the minimum of any
   * explicit input confidence and the referenced obligation's confidence.
   * Returns undefined when neither is known, so the row keeps the 1.0 default.
   *
   * Batch 10 H-2: when the caller SUPPLIES an obligation_id but the loader
   * returns null (the obligation does not exist in the Ledger or is in
   * another tenant), throw `obligation_not_found` instead of silently
   * skipping the cap. Pre-H-2 behaviour let an agent bypass
   * `agent.confidence.gte` simply by referencing a non-existent obligation_id,
   * because the cap path defaulted the row to confidence=1.0 and the
   * downstream §6 gate has no way to detect "id was provided but did not
   * resolve". This change moves that detection one layer up where the answer
   * is unambiguous.
   *
   * The "loader unwired" branch is unchanged: dev/test paths without the
   * loader keep their pre-H-2 behaviour (no cap, no throw). The production
   * fence already requires the loader to be wired in NODE_ENV=production.
   */
  private async resolveEffectiveConfidence(
    ctx: ServiceCallContext,
    input: CreatePaymentIntentInput,
  ): Promise<number | undefined> {
    let confidence = input.confidence;
    if (input.obligation_id !== undefined && this.deps.resolveObligationConfidence !== undefined) {
      const obligationConfidence = await this.deps.resolveObligationConfidence(
        ctx,
        input.obligation_id,
      );
      if (obligationConfidence === null) {
        throw brainError(
          "obligation_not_found",
          `obligation_id ${input.obligation_id} did not resolve in the Ledger; refusing to create a PaymentIntent referencing a missing obligation`,
          { details: { obligation_id: input.obligation_id } },
        );
      }
      confidence =
        confidence === undefined
          ? obligationConfidence
          : Math.min(confidence, obligationConfidence);
    }
    return confidence;
  }

  /**
   * Codex 2026-06-05 P2 — creation-time obligation-direction gate. A NEW
   * obligation-linked PaymentIntent must target a known `payable` obligation.
   * The §6 gate's check 6.7 rejects a `receivable` at execute but lets a `null`
   * (unknown) direction PASS — leaving legacy already-created rows lenient. This
   * closes the gap for NEW intents at the creation boundary (the natural
   * new-vs-legacy split): `null` (older rows / non-vendor-customer counterparty)
   * and `receivable` (money owed TO us; paying it out is the wrong-way drain
   * 6.7 guards) are both refused here, so a doomed or mis-directed intent is
   * never created.
   *
   * Enforced only when the direction loader is wired (the production money-path
   * fence requires it; dev/test without it keep prior behavior, matching the
   * confidence-cap loader's contract).
   */
  private async assertObligationDirectionPayable(
    ctx: ServiceCallContext,
    input: CreatePaymentIntentInput,
  ): Promise<void> {
    if (input.obligation_id === undefined || this.deps.resolveObligationDirection === undefined) {
      return;
    }
    const direction = await this.deps.resolveObligationDirection(ctx, input.obligation_id);
    if (direction !== "payable") {
      throw brainError(
        "obligation_direction_invalid",
        `obligation_id ${input.obligation_id} has direction '${direction ?? "unknown"}'; a new obligation-linked PaymentIntent must target a known payable obligation`,
        { details: { obligation_id: input.obligation_id, direction } },
      );
    }
  }

  public async create(
    ctx: ServiceCallContext,
    input: CreatePaymentIntentInput,
  ): Promise<PaymentIntent> {
    if (!/^\d+(\.\d+)?$/.test(input.amount) || input.amount === "0") {
      throw brainError("request_body_invalid", "amount must be a positive decimal string");
    }

    // RFC 0004 §5.2: an intent is no more confident than the Ledger evidence it
    // cites. Cap its confidence at the referenced obligation's so a low-
    // confidence (document-extracted) obligation gates the payment via policy.
    const effectiveConfidence = await this.resolveEffectiveConfidence(ctx, input);

    // Codex P2: a new obligation-linked intent must target a known payable
    // obligation (rejects null/receivable at creation; see the method doc).
    await this.assertObligationDirectionPayable(ctx, input);

    // Evaluate policy at creation time so the row carries a fresh
    // PolicyDecision id. Re-evaluation happens at execute() to defend
    // against state changes between propose and execute.
    const stub = stubGateIntent({
      id: "pi_PENDING",
      ownerId: ctx.tenantId,
      input:
        effectiveConfidence !== undefined ? { ...input, confidence: effectiveConfidence } : input,
    });
    const decision = await this.deps.evaluatePolicy(ctx, stub);

    const requiresApprovalFloor = requiresHardHumanApprovalFloor(stub, decision);
    const status: PaymentIntentStatus =
      decision.outcome === "reject"
        ? "rejected"
        : decision.outcome === "allow" && !requiresApprovalFloor
          ? "approved"
          : "pending_approval";

    const row = await withTenantScope(this.deps.pool, ctx.tenantId, (c) =>
      LedgerPaymentIntents.insert(c, {
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
        ...(effectiveConfidence !== undefined ? { confidence: effectiveConfidence } : {}),
        // x402 recipient — persisted only for x402_settle (DB CHECK enforces null
        // otherwise). The §6 gate re-validates it against the counterparty (6.5).
        ...(input.action_type === "x402_settle" && input.pay_to !== undefined
          ? { settlementPayTo: input.pay_to }
          : {}),
        // Escrow context — persisted only for escrow_release (DB CHECK enforces
        // null otherwise). The §6 gate binds it to the on-chain lock (6.6).
        ...(input.action_type === "escrow_release" &&
        input.escrow_id !== undefined &&
        input.job_terms_hash !== undefined
          ? { escrowId: input.escrow_id, jobTermsHash: input.job_terms_hash }
          : {}),
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
      LedgerPaymentIntents.findById(c, id),
    );
    return row === null ? null : toRecord(row);
  }

  public async list(
    ctx: ServiceCallContext,
    f: { status?: PaymentIntentStatus; agent_id?: string; limit?: number },
  ): Promise<PaymentIntent[]> {
    const rows = await withTenantScope(this.deps.pool, ctx.tenantId, (c) =>
      LedgerPaymentIntents.list(c, {
        ...(f.status !== undefined ? { status: f.status } : {}),
        ...(f.agent_id !== undefined ? { created_by_agent_id: f.agent_id } : {}),
        limit: Math.min(f.limit ?? 50, 500),
      }),
    );
    return rows.map(toRecord);
  }

  // ---- approve / reject / cancel ---------------------------------------

  public async approve(
    ctx: ServiceCallContext,
    id: string,
    opts: { assertedActorId?: string; payloadActorId?: unknown } = {},
  ): Promise<PaymentIntent> {
    const intent = await this.requireIntent(ctx, id);
    if (intent.status !== "pending_approval" && intent.status !== "awaiting_second_approval") {
      throw brainError(
        "payment_intent_invalid_state",
        `cannot approve PaymentIntent in status ${intent.status}`,
      );
    }

    const subject = { type: "payment_intent" as const, id };
    let actor: ActorContext | null = null;
    try {
      actor = await this.resolveApprovalActor(ctx, opts);
      const member = await this.deps.members?.findMemberById(ctx.tenantId, actor.memberId);
      const existingApprovals = await this.deps.approvals.list(ctx, subject);
      const fresh = await this.deps.evaluatePolicy(ctx, intentToGate(intent));
      const requiredDistinctApprovals = Math.max(1, fresh.required_approvers.length);
      const counterparty = await this.deps.resolveCounterparty(
        ctx,
        intent.destination_counterparty_id,
      );
      const payeeEmail =
        this.deps.resolveApprovalPayeeEmail !== undefined
          ? await this.deps.resolveApprovalPayeeEmail(ctx, intentToGate(intent))
          : null;
      const payeeKind = paymentIntentPayeeKind({
        actionType: intent.action_type,
        counterpartyType: counterparty?.type ?? null,
      });
      const authorization = authorizeApproval({
        actor,
        member: member ?? null,
        proposal: {
          domain: paymentIntentApprovalDomain(intent.action_type, payeeKind),
          amountCents: decimalAmountToCents(intent.amount),
          payeeKind,
          payeeEmail,
        },
        existingApproverMemberIds: existingApprovals.map((a) => a.approver_principal_id),
        requiredDistinctApprovals,
      });
      if (!authorization.allowed) {
        await this.emitApprovalRejected(
          ctx,
          intent,
          actor,
          authorization.reason,
          authorization.detail,
        );
        throw brainError("payment_intent_approval_invalid", authorization.reason, {
          statusOverride: 403,
          details: authorization.detail,
        });
      }

      const approvalCtx: ServiceCallContext = {
        ...ctx,
        actor: actor.memberId,
        principalType: "user",
      };

      // Record the approval only after member authority has passed every check.
      const approval = await this.deps.approvals.sign(
        approvalCtx,
        subject,
        authorization.approverRole,
      );
      await withTenantScope(this.deps.pool, ctx.tenantId, (c) =>
        LedgerPaymentIntents.appendApprovalId(c, id, approval.id),
      );

      if (authorization.requiresAdditionalApproval) {
        const updated = await withTenantScope(this.deps.pool, ctx.tenantId, async (c) => {
          assertPaymentIntentTransition("pending_approval", "awaiting_second_approval");
          return LedgerPaymentIntents.transition(
            c,
            id,
            "pending_approval",
            "awaiting_second_approval",
          );
        });
        const row = updated ?? (await this.requireIntent(ctx, id));
        await this.deps.audit.emit({
          tenantId: ctx.tenantId,
          layer: "agent",
          actor: actor.memberId,
          action: "proposal.awaiting_second_approval",
          inputs: { payment_intent_id: id, approval_id: approval.id },
          outputs: {
            status: "awaiting_second_approval",
            actor: { member_id: actor.memberId, verification: actor.verification },
            approvals: [
              {
                member_id: actor.memberId,
                at: approval.signed_at,
                verification: actor.verification,
              },
            ],
          },
          policyDecisionId: fresh.id,
        });
        if (this.deps.enqueue !== undefined) {
          void emitDomainEvent(this.deps.enqueue, {
            tenantId: ctx.tenantId,
            event: "proposal.awaiting_second_approval",
            context: {
              payment_intent_id: id,
              actor: { member_id: actor.memberId, verification: actor.verification },
            },
            ...(ctx.requestId !== undefined ? { requestId: ctx.requestId } : {}),
          }).catch(() => undefined);
        }
        return toRecord(row);
      }

      const updated = await withTenantScope(this.deps.pool, ctx.tenantId, async (c) => {
        assertPaymentIntentTransition(intent.status as PaymentIntentState, "approved");
        return LedgerPaymentIntents.transition(c, id, intent.status, "approved");
      });
      if (updated === null) {
        throw brainError(
          "payment_intent_invalid_state",
          "PaymentIntent moved between approve and authorization",
        );
      }
      await this.deps.audit.emit({
        tenantId: ctx.tenantId,
        layer: "agent",
        actor: actor.memberId,
        action: "payment_intent.approved",
        inputs: { payment_intent_id: id, approval_id: approval.id },
        outputs: {
          status: "approved",
          required_approvers: fresh.required_approvers,
          actor: { member_id: actor.memberId, verification: actor.verification },
          approvals: [
            { member_id: actor.memberId, at: approval.signed_at, verification: actor.verification },
          ],
        },
        policyDecisionId: fresh.id,
      });
      return toRecord(updated);
    } catch (err) {
      if (isBrainError(err) && err.details?.["reason"] === "actor_unresolved") {
        await this.emitApprovalRejected(ctx, intent, actor, "actor_unresolved", err.details);
      }
      throw err;
    }
  }

  public async reject(
    ctx: ServiceCallContext,
    id: string,
    reason?: string,
  ): Promise<PaymentIntent> {
    const intent = await this.requireIntent(ctx, id);
    if (
      intent.status !== "pending_approval" &&
      intent.status !== "awaiting_second_approval" &&
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
      LedgerPaymentIntents.transition(c, id, intent.status, "rejected"),
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
    // Domain-event producer (agent-router Phase 1): a rejected payment emits
    // `payment.failed` so the router can route to the collections agent. Routing
    // is advisory and must never fail the already-audited, durable rejection, so
    // emit best-effort (fire-and-forget; a queue hiccup cannot roll this back).
    if (this.deps.enqueue !== undefined) {
      void emitDomainEvent(this.deps.enqueue, {
        tenantId: ctx.tenantId,
        event: "payment.failed",
        context: { payment_intent_id: id, reason: reason ?? null },
        ...(ctx.requestId !== undefined ? { requestId: ctx.requestId } : {}),
      }).catch(() => undefined);
    }
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
      LedgerPaymentIntents.transition(c, id, "proposed", "cancelled"),
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

  // ---- kill-switch (1b.3) ----------------------------------------------

  /** GateDependencies bound to this ctx — shared by execute() and resume(). */
  private gateDeps(ctx: ServiceCallContext): GateDependencies {
    const resolveTenantFlags = this.deps.resolveTenantFlags;
    const attestCounterpartyAgent = this.deps.attestCounterpartyAgent;
    const sumAgentWindowSpend = this.deps.sumAgentWindowSpend;
    const resolveEscrowState = this.deps.resolveEscrowState;
    const sumActiveReservations = this.deps.sumActiveReservations;
    const resolveEvidence = this.deps.resolveEvidence;
    const detectDuplicates = this.deps.detectDuplicates;
    return {
      audit: this.deps.audit,
      resolveAgent: (agentId) => this.deps.resolveAgent(ctx, agentId),
      resolveAccount: (accountId) => this.deps.resolveAccount(ctx, accountId),
      resolveCounterparty: (cpId) => this.deps.resolveCounterparty(ctx, cpId),
      evaluatePolicy: (i) => this.deps.evaluatePolicy(ctx, i),
      resolveApprovals: async (intentId, activePolicyVersion) => ({
        // P0.4: count only currently-valid signatures; stale (superseded policy
        // version) and revoked signatures are excluded from quorum.
        signedRoles: await this.deps.approvals.signedValidRoles(
          ctx,
          { type: "payment_intent", id: intentId },
          activePolicyVersion ?? null,
        ),
      }),
      ...(resolveTenantFlags !== undefined
        ? { resolveTenantFlags: (tenantId: string) => resolveTenantFlags(ctx, tenantId) }
        : {}),
      // x402 gate loaders (RFC 0001 §6.3/§6.4) — passed through only when wired;
      // absent ⇒ gate checks 5.5/8.5 stay dormant (canonical path unchanged).
      ...(attestCounterpartyAgent !== undefined
        ? { attestCounterpartyAgent: (input) => attestCounterpartyAgent(ctx, input) }
        : {}),
      ...(sumAgentWindowSpend !== undefined
        ? {
            sumAgentWindowSpend: (agentId, windowSeconds) =>
              sumAgentWindowSpend(ctx, agentId, windowSeconds),
          }
        : {}),
      ...(resolveEscrowState !== undefined
        ? { resolveEscrowState: (input) => resolveEscrowState(ctx, input) }
        : {}),
      // Core safety loaders (§6 gate checks 8 / 9.5 / 11.5). When absent the
      // gate degrades to `not_applicable` — fine for dev/test, MANDATORY for
      // production. The composition-root parity lint
      // (scripts/check-payment-intent-loaders.mjs) catches missing wiring.
      ...(sumActiveReservations !== undefined
        ? { sumActiveReservations: (accountId) => sumActiveReservations(ctx, accountId) }
        : {}),
      ...(resolveEvidence !== undefined
        ? { resolveEvidence: (intent) => resolveEvidence(ctx, intent) }
        : {}),
      ...(detectDuplicates !== undefined
        ? { detectDuplicates: (input) => detectDuplicates(ctx, input) }
        : {}),
      // §6 gate check 6.7 (batch 10 H-1). Loader threaded through only when
      // the intent carries an obligation_id; the inner closure short-circuits
      // when the intent has no linked obligation, so we don't hit the loader
      // for the (still-common) intents that move money without one.
      ...(this.deps.resolveObligationDirection !== undefined
        ? {
            resolveObligationDirection: async (intent: GatePaymentIntent) => {
              const obligationId = intent.obligation_id;
              if (obligationId === null || obligationId === undefined) return null;
              return this.deps.resolveObligationDirection!(ctx, obligationId);
            },
          }
        : {}),
      // Phase 2 trust contract: obligation provenance for the low-trust
      // auto-execution rule (check 9.5). Same short-circuit shape as 6.7.
      ...(this.deps.resolveObligationProvenance !== undefined
        ? {
            resolveObligationProvenance: async (intent: GatePaymentIntent) => {
              const obligationId = intent.obligation_id;
              if (obligationId === null || obligationId === undefined) return null;
              return this.deps.resolveObligationProvenance!(ctx, obligationId);
            },
          }
        : {}),
      ...(this.deps.metrics !== undefined ? { metrics: this.deps.metrics } : {}),
    };
  }

  /** Pause an approved intent (kill-switch). approved → paused. */
  public async pause(ctx: ServiceCallContext, id: string): Promise<PaymentIntent> {
    const intent = await this.requireIntent(ctx, id);
    if (intent.status !== "approved") {
      throw brainError(
        "payment_intent_invalid_state",
        `pause only allowed from 'approved', current=${intent.status}`,
      );
    }
    assertPaymentIntentTransition("approved", "paused");
    const updated = await withTenantScope(this.deps.pool, ctx.tenantId, (c) =>
      LedgerPaymentIntents.transition(c, id, "approved", "paused"),
    );
    if (updated === null) {
      throw brainError("payment_intent_invalid_state", "PaymentIntent moved during pause");
    }
    await this.deps.audit.emit({
      tenantId: ctx.tenantId,
      layer: "agent",
      actor: ctx.actor,
      action: "payment_intent.paused",
      inputs: { payment_intent_id: id },
      outputs: { status: "paused" },
    });
    return toRecord(updated);
  }

  /** Resume a paused intent. Re-runs the live §6 gate first. paused → approved. */
  public async resume(ctx: ServiceCallContext, id: string): Promise<PaymentIntent> {
    const intent = await this.requireIntent(ctx, id);
    if (intent.status !== "paused") {
      throw brainError(
        "payment_intent_invalid_state",
        `resume only allowed from 'paused', current=${intent.status}`,
      );
    }
    // Re-run the live gate before re-entering approved — defends against Ledger
    // state drift (balance, sanctions, approvals) while the intent was paused.
    const principal = await this.deps.resolvePrincipal(ctx);
    const gate = await runPreExecutionGate(this.gateDeps(ctx), {
      ctx,
      principal,
      intent: intentToGate(intent),
    });
    if (!gate.ok) {
      await this.deps.audit.emit({
        tenantId: ctx.tenantId,
        layer: "agent",
        actor: ctx.actor,
        action: "payment_intent.resume.gate_failed",
        inputs: { payment_intent_id: id },
        outputs: { ok: false, failed_check: gate.failedCheck },
      });
      throw brainError(
        "payment_intent_gate_failed",
        `resume gate failed at check ${gate.failedCheck.index} (${gate.failedCheck.name})`,
        { statusOverride: 409, details: { check_index: gate.failedCheck.index } },
      );
    }
    assertPaymentIntentTransition("paused", "approved");
    const updated = await withTenantScope(this.deps.pool, ctx.tenantId, (c) =>
      LedgerPaymentIntents.transition(c, id, "paused", "approved"),
    );
    if (updated === null) {
      throw brainError("payment_intent_invalid_state", "PaymentIntent moved during resume");
    }
    await this.deps.audit.emit({
      tenantId: ctx.tenantId,
      layer: "agent",
      actor: ctx.actor,
      action: "payment_intent.resumed",
      inputs: { payment_intent_id: id },
      outputs: { status: "approved" },
    });
    return toRecord(updated);
  }

  /**
   * Pause every in-flight (approved) intent created by an agent (the PI side of
   * /v1/agents/{id}/halt). Returns the paused intent ids. The caller flips the
   * agent record to `quarantined` (agents repo) to complete the halt.
   */
  public async pauseByAgent(
    ctx: ServiceCallContext,
    agentId: string,
  ): Promise<{ paused: string[] }> {
    const paused = await withTenantScope(this.deps.pool, ctx.tenantId, async (c) => {
      const rows = await LedgerPaymentIntents.list(c, {
        status: "approved",
        created_by_agent_id: agentId,
        limit: 1000,
      });
      const ids: string[] = [];
      for (const row of rows) {
        const updated = await LedgerPaymentIntents.transition(c, row.id, "approved", "paused");
        if (updated !== null) ids.push(row.id);
      }
      return ids;
    });
    await this.deps.audit.emit({
      tenantId: ctx.tenantId,
      layer: "agent",
      actor: ctx.actor,
      action: "agent.halted",
      inputs: { agent_id: agentId },
      outputs: { paused_count: paused.length, paused_intent_ids: paused },
    });
    return { paused };
  }

  // ---- execute (the §6 gate path → durable outbox hand-off, H-04) ------

  /**
   * Run the §6 gate, then durably hand the action to the execution outbox.
   *
   * H-04: this method no longer dispatches the rail. After the gate passes
   * (audit-before emitted inside the gate) it does ONE transaction that both
   * (a) transitions the intent approved → dispatching and (b) inserts the
   * `pending` outbox row. Atomicity means a crash can never leave one without
   * the other; the outbox worker then dispatches the rail and settles the
   * intent via {@link completeExecution} / {@link failExecution}. The
   * conditional approved → dispatching transition doubles as the kill-switch
   * race guard (pause/cancel between gate and hand-off → the UPDATE matches no
   * row → we abort without enqueuing). Returns 202 with the outbox id.
   */
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

    const gate: GateResult = await runPreExecutionGate(this.gateDeps(ctx), {
      ctx,
      principal,
      intent: gateInput,
    });

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

    // Gate passed. Build the canonical rail payload the worker will dispatch.
    const railName = railFor(intent.action_type);
    const idempotencyKey = `pi:${intent.id}:${gate.policyDecisionId}`;
    const payload: Record<string, unknown> = {
      kind: intent.action_type,
      source_account_id: intent.source_account_id,
      destination_counterparty_id: intent.destination_counterparty_id,
      amount: intent.amount,
      currency: intent.currency,
    };

    // For on-chain transfers, merge the protocol-specific params into the payload
    // so the outbox worker can dispatch to OnchainBaseRail without further lookups.
    // Credentials never appear in the gate trace or audit-before; the merged payload
    // only exists in the outbox row (tenant-scoped, RLS-protected).
    if (intent.action_type === "onchain_transfer" && this.deps.resolveOnchainParams !== undefined) {
      const onchain = await this.deps.resolveOnchainParams(ctx, {
        source_account_id: intent.source_account_id,
        destination_counterparty_id: intent.destination_counterparty_id,
        amount: intent.amount,
        currency: intent.currency,
      });
      if (onchain !== null) {
        payload["smart_account"] = onchain.smart_account;
        payload["holder"] = onchain.holder;
        payload["target"] = onchain.target;
        payload["data"] = onchain.data;
        payload["value"] = onchain.value;
        payload["policy_version"] = onchain.policy_version;
      }
    }

    // For x402 settle, merge the rail fields the worker needs: asset, network, pay_to.
    // The NETWORK "base" matches the constant in x402-base.ts; the env BRAIN_X402_NETWORK
    // is informational for the facilitator client only.
    if (intent.action_type === "x402_settle") {
      payload["asset"] = intent.currency;
      payload["network"] = "base";
      if (intent.settlement_pay_to !== null) {
        payload["pay_to"] = intent.settlement_pay_to;
      }
    }

    // For escrow release, merge the on-chain lock identifiers and convert the
    // decimal amount to USDC base units (6 decimals) for BrainEscrow.release().
    if (intent.action_type === "escrow_release") {
      if (intent.escrow_id !== null) payload["escrow_id"] = intent.escrow_id;
      if (intent.job_terms_hash !== null) payload["job_terms_hash"] = intent.job_terms_hash;
      // Convert decimal amount string to USDC units (multiply by 1e6, no floats).
      const parts = intent.amount.split(".");
      const intPart = parts[0] ?? "0";
      const fracPart = (parts[1] ?? "").slice(0, 6).padEnd(6, "0");
      payload["amount_units"] = String(BigInt(intPart) * 1_000_000n + BigInt(fracPart));
    }

    // For ACH intents, merge the provider credentials (e.g. Plaid access_token)
    // into the outbox payload so the worker can dispatch without a second lookup.
    // Credentials are never included in the gate trace, audit-before, or audit-after.
    if (intent.action_type === "ach_outbound" && this.deps.sourceCredentialResolver !== undefined) {
      const creds = await this.deps.sourceCredentialResolver.resolve(ctx, intent.source_account_id);
      if (creds !== null) {
        const c = creds.credentials as Record<string, unknown>;
        if (typeof c["access_token"] === "string") payload["access_token"] = c["access_token"];
        if (typeof c["account_id"] === "string") payload["account_id"] = c["account_id"];
      }
    }

    // Atomic hand-off: claim approved → dispatching AND enqueue the outbox row
    // in the same transaction. If the conditional transition matches no row the
    // intent was paused/cancelled between gate and hand-off — abort, enqueue
    // nothing (the whole tx rolls back).
    const handoff = await withTenantScope(this.deps.pool, ctx.tenantId, async (c) => {
      assertPaymentIntentTransition("approved", "dispatching");
      const moved = await LedgerPaymentIntents.transition(c, intent.id, "approved", "dispatching");
      if (moved === null) {
        const cur = await LedgerPaymentIntents.findById(c, intent.id);
        return { ok: false as const, status: cur?.status ?? "missing" };
      }
      const reservationResult = requiresExecutionReservation(intent.action_type)
        ? await LedgerReservations.reserveIfAvailable(c, {
            id: newLedgerReservationId(),
            ownerId: ctx.tenantId,
            accountId: intent.source_account_id,
            amount: intent.amount,
            currency: intent.currency,
            paymentIntentId: intent.id,
            policyDecisionId: gate.policyDecisionId,
            reservingAgentId: intent.created_by_agent_id ?? principal.id,
            reservedUntil: new Date(Date.now() + EXECUTION_RESERVATION_TTL_MS),
          })
        : null;
      if (reservationResult !== null && !reservationResult.ok) {
        const code =
          reservationResult.reason === "available_balance_missing" ||
          reservationResult.reason === "account_not_found"
            ? "ledger_balance_unavailable"
            : "insufficient_balance";
        throw brainError(
          code,
          `execute aborted: unable to reserve funds (${reservationResult.reason})`,
          {
            details: {
              reason: reservationResult.reason,
              source_account_id: intent.source_account_id,
              available_balance: reservationResult.availableBalance,
              reserved: reservationResult.reserved,
              required: reservationResult.required,
            },
          },
        );
      }
      const reservation = reservationResult?.reservation ?? null;
      const enq = await this.deps.outbox.enqueue(c, ctx.tenantId, {
        paymentIntentId: intent.id,
        rail: railName,
        idempotencyKey,
        payload,
        auditBeforeId: gate.auditBeforeEventId,
        ...(reservation !== null ? { reservationId: reservation.id } : {}),
      });
      return { ok: true as const, outboxId: enq.id, reservationId: reservation?.id ?? null };
    });

    if (!handoff.ok) {
      await this.deps.audit.emit({
        tenantId: ctx.tenantId,
        layer: "agent",
        actor: ctx.actor,
        action: "payment_intent.execute.after",
        inputs: { payment_intent_id: id },
        outputs: { ok: false, aborted: true, status: handoff.status },
        policyDecisionId: gate.policyDecisionId,
      });
      throw brainError(
        "payment_intent_invalid_state",
        `execute aborted: intent no longer approved (status=${handoff.status})`,
        { statusOverride: 409 },
      );
    }

    // The dispatching transition is a write — audit it. This is NOT the §6
    // audit-after (that closes in the worker after rail dispatch); it records
    // the durable hand-off so the trail shows enqueue → worker settle.
    await this.deps.audit.emit({
      tenantId: ctx.tenantId,
      layer: "agent",
      actor: ctx.actor,
      action: "payment_intent.execute.enqueued",
      inputs: { payment_intent_id: id, rail: railName },
      outputs: {
        ok: true,
        status: "dispatching",
        outbox_id: handoff.outboxId,
        reservation_id: handoff.reservationId,
        gate_audit_before: gate.auditBeforeEventId,
      },
      policyDecisionId: gate.policyDecisionId,
    });

    return {
      payment_intent_id: intent.id,
      execution_id: null,
      outbox_id: handoff.outboxId,
      rail: railName,
      status: "dispatching",
    };
  }

  // ---- outbox callbacks (worker-only, H-04) ----------------------------

  /**
   * Settle a dispatched action: persist the execution row + rail receipt and
   * transition the intent dispatching → executed. Called by the outbox worker
   * AFTER it has dispatched the rail and emitted the §6 audit-after event. This
   * is the only method that drives a PaymentIntent to `executed`, which is what
   * the §6 gate-bypass guard pins to this file.
   *
   * Idempotent: if the intent is already `executed` (a reclaimed row being
   * re-processed after a crash) this is a no-op — checked BEFORE any insert so a
   * re-run can never duplicate the execution row. The whole body runs in one
   * transaction, so a settle either commits in full or rolls back in full.
   */
  public async completeExecution(
    ctx: ServiceCallContext,
    args: {
      paymentIntentId: string;
      executionId: string;
      rail: string;
      railReceipt: Record<string, unknown>;
      idempotencyKey: string;
      reservationId?: string | null;
    },
  ): Promise<void> {
    await withTenantScope(this.deps.pool, ctx.tenantId, async (c) => {
      const current = await LedgerPaymentIntents.findById(c, args.paymentIntentId);
      if (current === null) {
        throw brainError(
          "payment_intent_not_found",
          `completeExecution: intent ${args.paymentIntentId} not found`,
        );
      }
      if (current.status === "executed") {
        return; // already settled by a prior (crashed) run — idempotent no-op
      }
      if (current.status !== "dispatching") {
        throw brainError(
          "payment_intent_invalid_state",
          `completeExecution: intent ${args.paymentIntentId} in '${current.status}', expected 'dispatching'`,
        );
      }
      // §6 runtime invariant (defense-in-depth, mirrors the dispatch-site check
      // in outbox/worker.ts): the only legal path to `executed` runs through the
      // gate, which sets policy_decision_id atomically. If a future code path
      // races us to `dispatching` without that pointer, refuse to advance
      // rather than ship a row that violates the IPaymentIntentService contract
      // ("status = executed unreachable without policy_decision_id").
      if (current.policy_decision_id === null || current.policy_decision_id.length === 0) {
        throw brainError(
          "payment_intent_invalid_state",
          `completeExecution: intent ${args.paymentIntentId} has no policy_decision_id; §6 gate did not run`,
        );
      }
      await insertExecution(c, {
        id: args.executionId,
        tenantId: ctx.tenantId,
        proposalId: args.paymentIntentId,
        rail: args.rail,
        status: "dispatched",
        idempotencyKey: args.idempotencyKey,
      });
      await setExecutionReceipt(c, args.executionId, args.railReceipt);
      await transitionExecution(c, args.executionId, "dispatched", "in_flight");
      assertPaymentIntentTransition("dispatching", "executed");
      const executed = await LedgerPaymentIntents.transition(
        c,
        args.paymentIntentId,
        "dispatching",
        "executed",
      );
      if (executed === null) {
        throw brainError(
          "payment_intent_invalid_state",
          `completeExecution: intent ${args.paymentIntentId} moved before executed transition`,
        );
      }
      await LedgerPaymentIntents.appendExecutionReceiptId(
        c,
        args.paymentIntentId,
        args.executionId,
      );
      if (args.reservationId !== undefined && args.reservationId !== null) {
        await LedgerReservations.consume(c, args.reservationId);
      }
      // R-21: accumulate the agent's window spend/tx counters in the SAME
      // transaction as the executed transition, so a settle either records the
      // spend and advances state together or rolls back together. Agent-less
      // intents (human-initiated) have no per-agent counter to bump.
      if (this.deps.recordAgentSpend !== undefined && current.created_by_agent_id !== null) {
        await this.deps.recordAgentSpend(c, {
          tenantId: ctx.tenantId,
          agentId: current.created_by_agent_id,
          amount: current.amount,
          currency: current.currency,
        });
      }
    });
  }

  /**
   * Mark a dispatched action as failed (dispatching → failed). Used by the
   * outbox worker only for a DEFINITIVE rail rejection (nothing moved). Ambiguous
   * failures (timeout, post-dispatch receipt mismatch) must NOT call this — the
   * worker routes those to `reconciling` so ops can confirm whether money moved,
   * leaving the intent in `dispatching` rather than wrongly marking it failed.
   */
  public async failExecution(
    ctx: ServiceCallContext,
    args: { paymentIntentId: string; reservationId?: string | null },
  ): Promise<void> {
    await withTenantScope(this.deps.pool, ctx.tenantId, async (c) => {
      assertPaymentIntentTransition("dispatching", "failed");
      const failed = await LedgerPaymentIntents.transition(
        c,
        args.paymentIntentId,
        "dispatching",
        "failed",
      );
      if (failed === null) {
        throw brainError(
          "payment_intent_invalid_state",
          `failExecution: intent ${args.paymentIntentId} moved before failed transition`,
        );
      }
      if (args.reservationId !== undefined && args.reservationId !== null) {
        await LedgerReservations.release(c, args.reservationId);
      }
    });
  }

  // ---- replay-investigation (2.4) --------------------------------------

  /**
   * Forensic record for a PaymentIntent: the intent, its executions (each with
   * its typed rail receipt), and the linking ids. The policy decision, reservation,
   * and audit chain live in other services and are referenced by id here (joined
   * by the caller through their owning service APIs — cross-service read rule).
   */
  public async replayInvestigation(
    ctx: ServiceCallContext,
    id: string,
  ): Promise<{
    payment_intent: PaymentIntent;
    executions: ExecutionRow[];
    policy_decision_id: string | null;
    evidence_ids: string[];
  }> {
    const row = await this.requireIntent(ctx, id);
    const executions = await withTenantScope(this.deps.pool, ctx.tenantId, async (c) => {
      const out: ExecutionRow[] = [];
      for (const execId of row.execution_receipt_ids) {
        const ex = await findExecution(c, execId);
        if (ex !== null) out.push(ex);
      }
      return out;
    });
    return {
      payment_intent: toRecord(row),
      executions,
      policy_decision_id: row.policy_decision_id,
      evidence_ids: row.evidence_ids,
    };
  }

  // ---- internals -------------------------------------------------------

  private async resolveApprovalActor(
    ctx: ServiceCallContext,
    opts: { assertedActorId?: string; payloadActorId?: unknown },
  ): Promise<ActorContext> {
    if (this.deps.actorResolver === undefined) {
      throw brainError("internal_server_error", "approval actor resolver is not configured");
    }
    if (ctx.principalType === "api_partner") {
      return this.deps.actorResolver.resolve({
        kind: "api",
        ctx,
        ...(opts.assertedActorId !== undefined ? { assertedActorId: opts.assertedActorId } : {}),
      });
    }
    return this.deps.actorResolver.resolve({
      kind: "session",
      ctx,
      payloadActorId: opts.payloadActorId,
    });
  }

  private async emitApprovalRejected(
    ctx: ServiceCallContext,
    intent: PaymentIntentRow,
    actor: ActorContext | null,
    reason: ApprovalRejectionReason,
    detail: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.deps.audit.emit({
      tenantId: ctx.tenantId,
      layer: "agent",
      actor: actor?.memberId ?? ctx.actor,
      action: "approval_rejected",
      inputs: {
        payment_intent_id: intent.id,
        reason,
        actor:
          actor === null ? null : { member_id: actor.memberId, verification: actor.verification },
      },
      outputs: { status: intent.status, detail },
    });
  }

  private async requireIntent(ctx: ServiceCallContext, id: string): Promise<PaymentIntentRow> {
    const row = await withTenantScope(this.deps.pool, ctx.tenantId, (c) =>
      LedgerPaymentIntents.findById(c, id),
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
    case "x402_settle":
      return "x402_base";
    case "escrow_release":
      // On-chain BrainEscrow.release via the (deferred) escrow rail. No rail is
      // registered at boot, so RailRegistry fails closed — shadow-first.
      return "escrow_base";
    case "erp_writeback":
      return "erp_writeback";
    default:
      return "bank_ach";
  }
}

/**
 * Build the gate's on-chain `settlement` context (RFC 0001 §6.1) for an x402
 * settlement intent. The settled asset IS the intent currency (USDC) and the
 * network is Base (D-4). Absent for non-x402 actions or when the recipient is
 * not yet carried — then gate checks 3.5/6.5 stay dormant (no row), preserving
 * the canonical path. The gate (check 6.5) re-validates every field.
 */
export function gateSettlement(
  actionType: string,
  currency: string,
  amount: string,
  payTo: string | null | undefined,
): Pick<GatePaymentIntent, "settlement"> {
  if (actionType !== "x402_settle" || payTo === null || payTo === undefined) return {};
  return { settlement: { asset: currency, network: "base", amount, pay_to: payTo } };
}

/**
 * Build the gate's on-chain `escrow` context (RFC 0001 §6.2 / §7.6) for an
 * escrow_release intent. Absent for non-escrow actions or when the escrow id /
 * job-terms commitment is not yet carried — then gate check 6.6 stays dormant
 * (no row), preserving the canonical path. The gate (check 6.6) reads the
 * on-chain lock and re-validates state / amount / payee / job-terms.
 */
export function gateEscrow(
  actionType: string,
  escrowId: string | null | undefined,
  jobTermsHash: string | null | undefined,
): Pick<GatePaymentIntent, "escrow"> {
  if (
    actionType !== "escrow_release" ||
    escrowId === null ||
    escrowId === undefined ||
    jobTermsHash === null ||
    jobTermsHash === undefined
  ) {
    return {};
  }
  return { escrow: { escrowId, jobTermsHash } };
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
    confidence: row.confidence,
    ...gateSettlement(row.action_type, row.currency, row.amount, row.settlement_pay_to),
    ...gateEscrow(row.action_type, row.escrow_id, row.job_terms_hash),
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
    ...(args.input.confidence !== undefined ? { confidence: args.input.confidence } : {}),
    ...gateSettlement(
      args.input.action_type,
      args.input.currency,
      args.input.amount,
      args.input.pay_to,
    ),
    ...gateEscrow(args.input.action_type, args.input.escrow_id, args.input.job_terms_hash),
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
