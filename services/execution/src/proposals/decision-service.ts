import {
  brainError,
  InMemoryCardIssuer,
  InMemoryDisputeService,
  InMemoryLedgerDecisionService,
  InMemoryNotificationService,
  InMemoryPaymentReversalService,
  isBrainId,
  requireScope,
  withTenantScope,
  type AdapterReference,
  type AuditEmitter,
  type CardIssuer,
  type DisputeService,
  type LedgerDecisionService,
  type NotificationService,
  type PaymentReversalService,
  type Scope,
  type ServiceCallContext,
  type TenantScopedClient,
} from "@brain/shared";
import type { Pool } from "pg";
import type { PaymentIntentService } from "../payment-intents/PaymentIntentService.js";
import type { ActorResolver } from "../members/ActorResolver.js";
import type { ActorContext } from "../members/types.js";
import { isApprovalCapableRole } from "../members/authorizeApproval.js";
import { findUserAgentAuthority } from "../members/repository.js";
import type { RulesEngineService } from "../rules/rules-engine.js";
import { assertProposalTransition, type ProposalState } from "../state-machines.js";
import type { ProposalRow } from "../repository.js";
import { getProposal } from "./read-model.js";

export const PROPOSAL_DECISIONS = ["approve", "reject", "acknowledge", "undo"] as const;
export const PROPOSAL_DOMAIN_DECISIONS = [
  "confirm_legit",
  "block_merchant",
  "freeze_card",
  "fight",
  "refund",
  "confirm_all_matches",
  "escalate_to_accountant",
  "approve_as_new",
  "reject_duplicate",
  "hold_and_verify",
] as const;
export const ALL_PROPOSAL_DECISIONS = [
  ...PROPOSAL_DECISIONS,
  ...PROPOSAL_DOMAIN_DECISIONS,
] as const;
export type CanonicalProposalDecision = (typeof PROPOSAL_DECISIONS)[number];
export type ProposalDomainDecision = (typeof PROPOSAL_DOMAIN_DECISIONS)[number];
export type ProposalDecision = (typeof ALL_PROPOSAL_DECISIONS)[number];
const SCOPE_APPROVE: Scope = "payment_intent:approve";

export interface ProposalDecisionResult {
  id: string;
  decision: ProposalDecision;
  status: string;
  audit_id: string | null;
  payment_intent_id: string | null;
}

export interface CollectionsSendEmailInput {
  proposalId: string;
  to: string[];
  subject: string;
  body: string;
  threadId?: string;
}

export interface CollectionsSendEmailResult {
  messageId: string;
  threadId: string;
  sentFrom: string;
}

export interface CollectionsEmailSender {
  send(
    ctx: ServiceCallContext,
    input: CollectionsSendEmailInput,
  ): Promise<CollectionsSendEmailResult>;
}

export interface ProposalDecisionServiceDeps {
  pool: Pool;
  audit: AuditEmitter;
  actorResolver: ActorResolver;
  paymentIntents: PaymentIntentService;
  cardIssuer?: CardIssuer;
  disputeService?: DisputeService;
  paymentReversalService?: PaymentReversalService;
  ledgerDecisionService?: LedgerDecisionService;
  notificationService?: NotificationService;
  collectionsEmailSender?: CollectionsEmailSender;
  rules?: RulesEngineService;
}

export class ProposalDecisionService {
  public constructor(private readonly deps: ProposalDecisionServiceDeps) {}

  public async decide(
    ctx: ServiceCallContext,
    proposalId: string,
    decision: ProposalDecision,
  ): Promise<ProposalDecisionResult> {
    if (!isBrainId(proposalId, "pi") && !isBrainId(proposalId, "prop")) {
      throw brainError("request_params_invalid", "malformed proposal id");
    }
    const proposal = await getProposal(this.deps.pool, ctx, proposalId);
    if (proposal === null) {
      throw brainError("execution_proposal_not_found", "no such proposal");
    }
    if (proposal.payment_intent_id !== null) {
      if (isDomainDecision(decision)) {
        throw brainError(
          "execution_proposal_invalid_state",
          `${decision} is not valid for money-path proposals`,
        );
      }
      return this.decideMoneyPath(ctx, proposal.payment_intent_id, decision, proposal.status);
    }
    if (isDomainDecision(decision)) {
      return this.decideDomainProposal(ctx, proposalId, decision);
    }
    return this.decideAgentProposal(ctx, proposalId, decision);
  }

  private async decideMoneyPath(
    ctx: ServiceCallContext,
    paymentIntentId: string,
    decision: CanonicalProposalDecision,
    beforeStatus: string,
  ): Promise<ProposalDecisionResult> {
    if (decision !== "approve" && decision !== "reject") {
      throw brainError(
        "execution_proposal_invalid_state",
        `${decision} is not valid for money-path proposals`,
      );
    }
    requireScope(ctx.scopes ?? [], SCOPE_APPROVE);
    let updated: { status: string; decision_audit_id?: string | null };
    if (decision === "approve") {
      updated = await this.deps.paymentIntents.approve(ctx, paymentIntentId);
    } else {
      const actor = await this.resolveSessionActor(ctx);
      if (beforeStatus === "rejected") {
        return {
          id: paymentIntentId,
          decision,
          status: beforeStatus,
          audit_id: await findDecisionAuditIdByPrefix(
            this.deps.pool,
            ctx.tenantId,
            proposalDecisionAuditPrefix(paymentIntentId, decision),
          ),
          payment_intent_id: paymentIntentId,
        };
      }
      updated = await this.deps.paymentIntents.reject(
        { ...ctx, actor: actor.memberId, principalType: "user" },
        paymentIntentId,
      );
    }
    return {
      id: paymentIntentId,
      decision,
      status: updated.status,
      audit_id: updated.decision_audit_id ?? null,
      payment_intent_id: paymentIntentId,
    };
  }

  private async decideAgentProposal(
    ctx: ServiceCallContext,
    proposalId: string,
    decision: CanonicalProposalDecision,
  ): Promise<ProposalDecisionResult> {
    const actor = await this.resolveSessionActor(ctx);
    return withTenantScope(this.deps.pool, ctx.tenantId, async (client) => {
      const before = await findProposalForUpdate(client, proposalId);
      if (before === null) {
        throw brainError("execution_proposal_not_found", "no such proposal");
      }
      const denied = await evaluateDecisionAuthority(
        this.deps,
        ctx,
        client,
        actor,
        before,
        decision,
      );
      if (denied !== null) {
        return blockProposalDecision(this.deps, ctx, client, actor, before, decision, denied);
      }
      if (decision === "approve" && isVendorRiskEditProposal(before)) {
        return this.executeVendorRiskEditPath(ctx, client, actor, before);
      }
      if (decision === "approve" && isCollectionsEmailProposal(before)) {
        return this.executeCollectionsEmailPath(ctx, client, actor, before);
      }
      const target = targetStatusForDecision(before, decision);
      if (target.idempotent) {
        return {
          id: before.id,
          decision,
          status: before.status,
          audit_id: await findDecisionAuditId(
            client,
            proposalDecisionAuditPrefix(before.id, decision),
          ),
          payment_intent_id: null,
        };
      }

      const afterState = { ...proposalAuditEnvelope(before), status: target.status };
      const audit = await this.deps.audit.emit({
        tenantId: ctx.tenantId,
        layer: "agent",
        actor: actor.memberId,
        action: "proposal.decided",
        inputs: { proposal_id: before.id, decision },
        outputs: {
          status: target.status,
          actor: { member_id: actor.memberId, verification: actor.verification },
          // `outputs` is what services/audit/src/routes.ts serializes from
          // GET /audit/events. Keep the proposal context here so the audit
          // record remains meaningful without a live proposal lookup.
          proposal_summary: {
            proposing_agent: before.proposing_agent,
            ...proposalActionSnapshot(before),
          },
        },
        beforeState: proposalAuditEnvelope(before),
        afterState,
        idempotencyKey: proposalDecisionAuditKey(before.id, decision, before.status),
      });

      assertProposalTransition(before.status, target.status);
      const updated = await transitionProposalStatus(
        client,
        before.id,
        before.status,
        target.status,
        decision,
        audit.id,
        audit.createdAt,
      );
      return {
        id: updated.id,
        decision,
        status: updated.status,
        audit_id: audit.id,
        payment_intent_id: null,
      };
    });
  }

  private async decideDomainProposal(
    ctx: ServiceCallContext,
    proposalId: string,
    decision: ProposalDomainDecision,
  ): Promise<ProposalDecisionResult> {
    const actor = await this.resolveSessionActor(ctx);
    return withTenantScope(this.deps.pool, ctx.tenantId, async (client) => {
      const before = await findProposalForUpdate(client, proposalId);
      if (before === null) {
        throw brainError("execution_proposal_not_found", "no such proposal");
      }
      const denied = await evaluateDecisionAuthority(
        this.deps,
        ctx,
        client,
        actor,
        before,
        decision,
      );
      if (denied !== null) {
        return blockProposalDecision(this.deps, ctx, client, actor, before, decision, denied);
      }
      assertDomainDecisionMatchesProposal(before, decision);
      if (before.status === "executed" && before.decision === decision) {
        return {
          id: before.id,
          decision,
          status: before.status,
          audit_id: await findDecisionAuditId(
            client,
            decisionExecutedAuditPrefix(before.id, decision),
          ),
          payment_intent_id: null,
        };
      }
      if (before.status !== "pending" && before.status !== "approved") {
        throw invalidDecision(before, decision);
      }
      const execution = await executeDomainDecision(this.deps, ctx, client, before, decision);
      const audit = await emitDecisionExecuted(this.deps, ctx, actor, before, decision, execution);
      if (decision === "approve_as_new") {
        await emitInvoiceApproved(this.deps, ctx, actor, before, execution);
      }
      assertProposalTransition(before.status, "executed");
      const updated = await transitionProposalStatus(
        client,
        before.id,
        before.status,
        "executed",
        decision,
        audit.id,
        audit.createdAt,
      );
      return {
        id: updated.id,
        decision,
        status: updated.status,
        audit_id: audit.id,
        payment_intent_id: null,
      };
    });
  }

  private async executeVendorRiskEditPath(
    ctx: ServiceCallContext,
    client: TenantScopedClient,
    actor: ActorContext,
    before: ProposalRow,
  ): Promise<ProposalDecisionResult> {
    if (before.status === "executed" && before.decision === "approve") {
      return {
        id: before.id,
        decision: "approve",
        status: before.status,
        audit_id: await findDecisionAuditId(
          client,
          decisionExecutedAuditPrefix(before.id, "approve"),
        ),
        payment_intent_id: null,
      };
    }
    if (before.status !== "pending" && before.status !== "approved") {
      throw invalidDecision(before, "approve");
    }
    const execution = await executeVendorRiskEdit(ctx, client, before);
    const audit = await emitDecisionExecuted(this.deps, ctx, actor, before, "approve", execution);
    assertProposalTransition(before.status, "executed");
    const updated = await transitionProposalStatus(
      client,
      before.id,
      before.status,
      "executed",
      "approve",
      audit.id,
      audit.createdAt,
    );
    return {
      id: updated.id,
      decision: "approve",
      status: updated.status,
      audit_id: audit.id,
      payment_intent_id: null,
    };
  }

  private async executeCollectionsEmailPath(
    ctx: ServiceCallContext,
    client: TenantScopedClient,
    actor: ActorContext,
    before: ProposalRow,
  ): Promise<ProposalDecisionResult> {
    if (before.status === "executed" && before.decision === "approve") {
      return {
        id: before.id,
        decision: "approve",
        status: before.status,
        audit_id: await findDecisionAuditId(
          client,
          decisionExecutedAuditPrefix(before.id, "approve"),
        ),
        payment_intent_id: null,
      };
    }
    if (before.status !== "pending" && before.status !== "approved") {
      throw invalidDecision(before, "approve");
    }
    const execution = await executeCollectionsEmail(this.deps, ctx, before);
    const audit = await emitDecisionExecuted(this.deps, ctx, actor, before, "approve", execution);
    assertProposalTransition(before.status, "executed");
    const updated = await transitionProposalStatus(
      client,
      before.id,
      before.status,
      "executed",
      "approve",
      audit.id,
      audit.createdAt,
    );
    return {
      id: updated.id,
      decision: "approve",
      status: updated.status,
      audit_id: audit.id,
      payment_intent_id: null,
    };
  }

  private async resolveSessionActor(ctx: ServiceCallContext): Promise<ActorContext> {
    if (ctx.actor === "system:rules-engine") {
      return {
        memberId: ctx.actor,
        email: "rules-engine@brain.invalid",
        role: "admin",
        active: true,
        verification: "tenant_asserted",
        assertedBy: "rule",
      };
    }
    return this.deps.actorResolver.resolve({ kind: "session", ctx });
  }
}

function proposalDecisionAuditKey(
  proposalId: string,
  decision: ProposalDecision,
  beforeStatus: string,
): string {
  return `proposal.decided:${proposalId}:${decision}:${beforeStatus}`;
}

function proposalDecisionAuditPrefix(proposalId: string, decision: ProposalDecision): string {
  return `proposal.decided:${proposalId}:${decision}:`;
}

function decisionExecutedAuditKey(
  proposalId: string,
  decision: ProposalDecision,
  beforeStatus: string,
): string {
  return `decision.executed:${proposalId}:${decision}:${beforeStatus}`;
}

function decisionExecutedAuditPrefix(proposalId: string, decision: ProposalDecision): string {
  return `decision.executed:${proposalId}:${decision}:`;
}

function invoiceApprovedAuditKey(
  proposalId: string,
  invoiceId: string,
  beforeStatus: string,
): string {
  return `invoice.approved:${proposalId}:${invoiceId}:${beforeStatus}`;
}

function proposalAuditEnvelope(row: ProposalRow): Record<string, unknown> {
  return {
    id: row.id,
    proposing_agent: row.proposing_agent,
    status: row.status,
    policy_decision: row.policy_decision,
    required_approvers: row.required_approvers,
    approvers_signed: row.approvers_signed,
    ...proposalActionSnapshot(row),
  };
}

/**
 * Decision-time snapshot of presentation fields emitted by internal-agent
 * proposal handlers. This is deliberately a narrow whitelist, not the full
 * action blob, so future handler fields are not made permanent audit data
 * without review.
 */
function proposalActionSnapshot(row: ProposalRow): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const key of PROPOSAL_SNAPSHOT_KEYS) {
    const value = row.action[key];
    if (value !== undefined) snapshot[key] = value;
  }
  return snapshot;
}

const PROPOSAL_SNAPSHOT_KEYS = [
  "narrative",
  "summary",
  "risk_band",
  "finding_type",
  "severity",
  "rule_id",
  "affected_entities",
  "evidence_refs",
  "recommended_remediation",
] as const;

type TargetStatus =
  | { status: ProposalState; idempotent: false }
  | { status: ProposalState; idempotent: true };

function targetStatusForDecision(
  row: ProposalRow,
  decision: CanonicalProposalDecision,
): TargetStatus {
  switch (decision) {
    case "approve":
      if (row.status === "approved") {
        return { status: "approved", idempotent: true };
      }
      if (row.status !== "pending") {
        throw invalidDecision(row, decision);
      }
      return { status: "approved", idempotent: false };
    case "reject":
      if (row.status === "rejected") {
        return { status: "rejected", idempotent: true };
      }
      if (row.status !== "pending" && row.status !== "approved") {
        throw invalidDecision(row, decision);
      }
      return { status: "rejected", idempotent: false };
    case "acknowledge":
      if (row.status === "acknowledged") {
        return { status: "acknowledged", idempotent: true };
      }
      // BC-3: AgentService stamps this mode from the trusted agent definition.
      // Inbound handler payloads cannot self-assert notify_only here.
      if (row.status !== "pending" || row.action["mode"] !== "notify_only") {
        throw invalidDecision(row, decision);
      }
      return { status: "acknowledged", idempotent: false };
    case "undo":
      if (row.status === "undone") {
        return { status: "undone", idempotent: true };
      }
      if (row.status !== "approved") {
        throw invalidDecision(row, decision);
      }
      return { status: "undone", idempotent: false };
  }
}

function invalidDecision(row: ProposalRow, decision: ProposalDecision): Error {
  return brainError(
    "execution_proposal_invalid_state",
    `cannot ${decision} proposal in status ${row.status}`,
  );
}

function assertAgentDecisionAuthority(actor: ActorContext, decision: ProposalDecision): void {
  if (!actor.active) {
    throw approvalDenied("actor_inactive", { member_id: actor.memberId });
  }
  if (decision !== "acknowledge" && !isApprovalCapableRole(actor.role)) {
    throw approvalDenied("domain_not_authorized", { member_id: actor.memberId, role: actor.role });
  }
}

interface AuthorityDenial {
  reason: string;
  detail: Record<string, unknown>;
}

async function evaluateDecisionAuthority(
  deps: ProposalDecisionServiceDeps,
  ctx: ServiceCallContext,
  client: TenantScopedClient,
  actor: ActorContext,
  row: ProposalRow,
  decision: ProposalDecision,
): Promise<AuthorityDenial | null> {
  try {
    assertAgentDecisionAuthority(actor, decision);
  } catch (err) {
    return denialFromError(err);
  }
  const agent = agentKeyFor(row);
  const userAuthority = await findUserAgentAuthority(client, actor.memberId, agent);
  const amountCents = proposalAmountCents(row);
  if (userAuthority !== null) {
    const denied = userAuthorityDenial(userAuthority, decision, amountCents);
    if (denied !== null) return denied;
  }
  if (deps.rules !== undefined) {
    const rule = await deps.rules.evaluate(ctx, agent, {
      ...row.action,
      decision,
      actor: {
        id: actor.memberId,
        role: actor.role,
        authority:
          userAuthority === null
            ? null
            : {
                can_approve: userAuthority.canApprove,
                can_edit: userAuthority.canEdit,
                can_reject: userAuthority.canReject,
                max_amount_cents:
                  userAuthority.maxAmountCents === null
                    ? null
                    : Number(userAuthority.maxAmountCents),
                can_delegate: userAuthority.canDelegate,
              },
      },
    });
    if (rule.authority === "deny") {
      return {
        reason: "rule_authority_denied",
        detail: { rule_id: rule.rule_id, agent, decision },
      };
    }
  }
  return null;
}

function userAuthorityDenial(
  authority: Awaited<ReturnType<typeof findUserAgentAuthority>>,
  decision: ProposalDecision,
  amountCents: bigint | null,
): AuthorityDenial | null {
  if (authority === null) return null;
  if (decision === "approve" && !authority.canApprove) {
    return { reason: "user_agent_approval_denied", detail: { agent: authority.agent } };
  }
  if ((decision === "reject" || decision === "reject_duplicate") && !authority.canReject) {
    return { reason: "user_agent_reject_denied", detail: { agent: authority.agent } };
  }
  if (
    decision !== "approve" &&
    decision !== "reject" &&
    decision !== "reject_duplicate" &&
    !authority.canEdit
  ) {
    return { reason: "user_agent_edit_denied", detail: { agent: authority.agent } };
  }
  if (
    decision === "approve" &&
    authority.maxAmountCents !== null &&
    amountCents !== null &&
    amountCents > authority.maxAmountCents
  ) {
    return {
      reason: "user_agent_limit_exceeded",
      detail: {
        agent: authority.agent,
        amount_cents: amountCents.toString(),
        limit_cents: authority.maxAmountCents.toString(),
      },
    };
  }
  return null;
}

async function blockProposalDecision(
  deps: ProposalDecisionServiceDeps,
  ctx: ServiceCallContext,
  client: TenantScopedClient,
  actor: ActorContext,
  before: ProposalRow,
  decision: ProposalDecision,
  denial: AuthorityDenial,
): Promise<ProposalDecisionResult> {
  const afterState = { ...proposalAuditEnvelope(before), status: "blocked" };
  const audit = await deps.audit.emit({
    tenantId: ctx.tenantId,
    layer: "agent",
    actor: actor.memberId,
    action: "decision.denied",
    inputs: { proposal_id: before.id, decision },
    outputs: {
      actor: { member_id: actor.memberId, verification: actor.verification },
      reason: denial.reason,
      detail: denial.detail,
      proposal_summary: {
        proposing_agent: before.proposing_agent,
        ...proposalActionSnapshot(before),
      },
    },
    beforeState: proposalAuditEnvelope(before),
    afterState,
    idempotencyKey: `decision.denied:${before.id}:${decision}:${before.status}`,
  });
  const updated = await transitionProposalStatus(
    client,
    before.id,
    before.status,
    "blocked",
    decision,
    audit.id,
    audit.createdAt,
  );
  return {
    id: updated.id,
    decision,
    status: updated.status,
    audit_id: audit.id,
    payment_intent_id: null,
  };
}

function denialFromError(err: unknown): AuthorityDenial {
  const details =
    typeof err === "object" && err !== null && "details" in err
      ? ((err as { details?: Record<string, unknown> }).details ?? {})
      : {};
  const reason = typeof details["reason"] === "string" ? details["reason"] : "role_denied";
  return { reason, detail: details };
}

function proposalAmountCents(row: ProposalRow): bigint | null {
  for (const key of ["amount_cents", "value_cents", "unmatched_total_cents"]) {
    const value = row.action[key];
    const parsed = bigintish(value);
    if (parsed !== null) return parsed;
  }
  for (const key of ["amount", "amount_due", "unmatched_total"]) {
    const value = row.action[key];
    const parsed = decimalToCents(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function bigintish(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return BigInt(value);
  return null;
}

function decimalToCents(value: unknown): bigint | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value);
  const match = /^([0-9]+)(?:\.([0-9]{1,2}))?$/.exec(text);
  if (match === null) return null;
  return BigInt(match[1] ?? "0") * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
}

function approvalDenied(reason: string, detail: Record<string, unknown>): Error {
  return brainError("payment_intent_approval_invalid", reason, {
    statusOverride: 403,
    details: { reason, ...detail },
  });
}

async function findProposalForUpdate(
  client: TenantScopedClient,
  id: string,
): Promise<ProposalRow | null> {
  const { rows } = await client.query<ProposalRow>(
    `SELECT *
       FROM proposals
      WHERE id = $1
        AND tenant_id = current_setting('app.tenant_id', true)
      FOR UPDATE`,
    [id],
  );
  return rows[0] ?? null;
}

async function transitionProposalStatus(
  client: TenantScopedClient,
  id: string,
  from: ProposalState,
  to: ProposalState,
  decision: ProposalDecision,
  auditId: string,
  decidedAt: string,
): Promise<ProposalRow> {
  const { rows } = await client.query<ProposalRow>(
    `UPDATE proposals
        SET status = $1,
            decision = $4,
            decision_audit_id = $5,
            decided_at = $6::timestamptz,
            updated_at = now()
      WHERE id = $2 AND status = $3
        AND tenant_id = current_setting('app.tenant_id', true)
      RETURNING *`,
    [to, id, from, decision, auditId, decidedAt],
  );
  const row = rows[0];
  if (row === undefined) {
    throw brainError("execution_proposal_invalid_state", "proposal moved during decision");
  }
  return row;
}

interface DecisionExecutionResult {
  readonly outcome: string;
  readonly outbound_reference_ids: readonly string[];
  readonly details?: Record<string, unknown>;
}

function isDomainDecision(decision: ProposalDecision): decision is ProposalDomainDecision {
  return PROPOSAL_DOMAIN_DECISIONS.includes(decision as ProposalDomainDecision);
}

function agentKeyFor(row: ProposalRow): string {
  return (
    readString(row.action["agent_role"]) ||
    readString(row.action["type"]) ||
    readString(row.action["agent_id"]) ||
    row.proposing_agent
  );
}

function assertDomainDecisionMatchesProposal(
  row: ProposalRow,
  decision: ProposalDomainDecision,
): void {
  const agent = agentKeyFor(row);
  const allowed = DOMAIN_DECISIONS_BY_AGENT[agent] ?? [];
  if (!allowed.includes(decision)) {
    throw brainError(
      "execution_proposal_invalid_state",
      `${decision} is not valid for ${agent} proposals`,
    );
  }
}

const DOMAIN_DECISIONS_BY_AGENT: Record<string, readonly ProposalDomainDecision[]> = {
  fraud_anomaly: ["confirm_legit", "block_merchant", "freeze_card"],
  dispute: ["fight", "refund"],
  reconciliation: ["confirm_all_matches", "escalate_to_accountant"],
  invoice_integrity: ["approve_as_new", "reject_duplicate", "hold_and_verify"],
};

async function executeDomainDecision(
  deps: ProposalDecisionServiceDeps,
  ctx: ServiceCallContext,
  client: TenantScopedClient,
  row: ProposalRow,
  decision: ProposalDomainDecision,
): Promise<DecisionExecutionResult> {
  switch (decision) {
    case "confirm_legit":
      return references("confirmed_legitimate", [], {
        transaction_id: readString(row.action["transaction_id"]) || null,
      });
    case "block_merchant":
      return executeBlockMerchant(deps, row);
    case "freeze_card":
      return executeFreezeCard(deps, row);
    case "fight":
      return executeDisputeFight(deps, row);
    case "refund":
      return executeDisputeRefund(deps, row);
    case "confirm_all_matches":
      return executeConfirmAllMatches(deps, row);
    case "escalate_to_accountant":
      return executeEscalateToAccountant(deps, ctx, row);
    case "approve_as_new":
      return executeInvoiceDecision(deps, client, row, "approve_as_new");
    case "reject_duplicate":
      return executeInvoiceDecision(deps, client, row, "reject_duplicate");
    case "hold_and_verify":
      return executeInvoiceDecision(deps, client, row, "hold_and_verify");
  }
}

async function executeFreezeCard(
  deps: ProposalDecisionServiceDeps,
  row: ProposalRow,
): Promise<DecisionExecutionResult> {
  const cardId = requiredActionString(row, "card_id");
  const txnId = requiredActionString(row, "transaction_id");
  const reason = readString(row.action["dispute_reason"], "suspected_fraud");
  const cardIssuer = deps.cardIssuer ?? new InMemoryCardIssuer();
  const disputeService = deps.disputeService ?? new InMemoryDisputeService();
  const [freeze, dispute] = await Promise.all([
    cardIssuer.freeze(cardId),
    disputeService.file(txnId, reason),
  ]);
  return references("frozen", [freeze, dispute], { card_id: cardId, transaction_id: txnId });
}

async function executeBlockMerchant(
  deps: ProposalDecisionServiceDeps,
  row: ProposalRow,
): Promise<DecisionExecutionResult> {
  const txnId = requiredActionString(row, "transaction_id");
  const merchantDescriptor =
    readString(row.action["merchant_descriptor"]) ||
    readString(row.action["counterparty_name"]) ||
    readString(row.action["description"]);
  const reason = readString(row.action["dispute_reason"], "suspected_fraud");
  const disputeService = deps.disputeService ?? new InMemoryDisputeService();
  const dispute = await disputeService.file(txnId, reason);
  const blockReference =
    merchantDescriptor.length > 0 ? `merchant_block:${merchantDescriptor}` : "merchant_block";
  return {
    outcome: "merchant_blocked",
    outbound_reference_ids: [dispute.reference_id, blockReference],
    details: {
      transaction_id: txnId,
      merchant_descriptor: merchantDescriptor || null,
      card_state: "active",
    },
  };
}

async function executeDisputeFight(
  deps: ProposalDecisionServiceDeps,
  row: ProposalRow,
): Promise<DecisionExecutionResult> {
  const disputeId = requiredActionString(row, "dispute_id");
  const evidence = row.action["evidence_bundle"] ?? row.action["evidence_checklist"] ?? [];
  const service = deps.disputeService ?? new InMemoryDisputeService();
  const submitted = await service.submit_evidence(disputeId, evidence);
  return references("evidence_submitted", [submitted], {
    dispute_id: disputeId,
    submitted_at: new Date().toISOString(),
  });
}

async function executeDisputeRefund(
  deps: ProposalDecisionServiceDeps,
  row: ProposalRow,
): Promise<DecisionExecutionResult> {
  const txnId = requiredActionString(row, "transaction_id");
  const amount = requiredActionString(row, "amount");
  const reason = readString(row.action["refund_reason"], "dispute_refund");
  const service = deps.paymentReversalService ?? new InMemoryPaymentReversalService();
  const refunded = await service.refund(txnId, amount, reason);
  return references("refunded", [refunded], { transaction_id: txnId, amount });
}

async function executeConfirmAllMatches(
  deps: ProposalDecisionServiceDeps,
  row: ProposalRow,
): Promise<DecisionExecutionResult> {
  const candidateIds = readStringArray(row.action["candidate_ids"]);
  const rankedCandidates = readRecords(row.action["ranked_candidates"])
    .map((candidate) => readString(candidate["id"]))
    .filter((id) => id.length > 0);
  const ids = candidateIds.length > 0 ? candidateIds : rankedCandidates;
  if (ids.length === 0) {
    throw brainError("request_body_invalid", "candidate_ids are required");
  }
  const service = deps.ledgerDecisionService ?? new InMemoryLedgerDecisionService();
  const refs: AdapterReference[] = [];
  for (const id of ids) {
    refs.push(await service.commit_match(id));
  }
  return references("close_confirmed", refs, {
    candidate_ids: ids,
    close_aggregate: row.action["close_aggregate"] ?? null,
  });
}

async function executeEscalateToAccountant(
  deps: ProposalDecisionServiceDeps,
  ctx: ServiceCallContext,
  row: ProposalRow,
): Promise<DecisionExecutionResult> {
  const accountant = resolveAccountantContact(deps.pool, ctx, row);
  const service = deps.notificationService ?? new InMemoryNotificationService();
  const sent = await service.email(
    accountant,
    "Reconciliation close needs review",
    readString(row.action["narrative"], "Reconciliation close needs review."),
    readRecords(row.action["attachments"]),
  );
  return references("escalated", [sent], {
    accountant,
    reminder_after: "P1D",
  });
}

async function executeInvoiceDecision(
  deps: ProposalDecisionServiceDeps,
  client: TenantScopedClient,
  row: ProposalRow,
  decision: "approve_as_new" | "reject_duplicate" | "hold_and_verify",
): Promise<DecisionExecutionResult> {
  const invoiceId = invoiceIdFor(row);
  const service = deps.notificationService ?? new InMemoryNotificationService();
  const refs: AdapterReference[] = [];
  await updateInvoiceProjection(client, invoiceId, decision);
  if (decision === "reject_duplicate") {
    const vendor = readString(row.action["vendor_contact"]) || "vendor@example.invalid";
    refs.push(
      await service.email(
        vendor,
        "Invoice void notice",
        `Invoice ${invoiceId} was rejected as a duplicate.`,
      ),
    );
    return references("duplicate_rejected", refs, { invoice_id: invoiceId });
  }
  if (decision === "hold_and_verify") {
    refs.push(
      await service.task(
        readString(row.action["assignee"], "unassigned"),
        "Verify invoice with vendor",
        { invoice_id: invoiceId, proposal_id: row.id },
      ),
    );
    return references("held_for_verification", refs, {
      invoice_id: invoiceId,
      reminder_after: "P1D",
    });
  }
  return references("invoice_approved", refs, {
    invoice_id: invoiceId,
    emitted_event: "invoice.approved",
  });
}

async function executeCollectionsEmail(
  deps: ProposalDecisionServiceDeps,
  ctx: ServiceCallContext,
  row: ProposalRow,
): Promise<DecisionExecutionResult> {
  if (deps.collectionsEmailSender === undefined) {
    throw brainError("integration_provider_not_configured", "email not connected", {
      statusOverride: 409,
      details: {
        friendly_message: "Connect Email and calendar in Sources before sending collections email.",
      },
    });
  }
  const draft = readObject(row.action["draft_email"]);
  if (draft === null) throw brainError("request_body_invalid", "draft_email is required");
  const to = readStringArray(draft["to"]);
  const directTo = readString(draft["to"]);
  const recipients = to.length > 0 ? to : directTo.length > 0 ? [directTo] : [];
  if (recipients.length === 0)
    throw brainError("request_body_invalid", "draft_email.to is required");
  const subject = readString(draft["subject"]);
  if (subject.length === 0)
    throw brainError("request_body_invalid", "draft_email.subject is required");
  const bodyParts = readStringArray(draft["body"]);
  const body = bodyParts.length > 0 ? bodyParts.join("\n\n") : readString(draft["body"]);
  if (body.length === 0) throw brainError("request_body_invalid", "draft_email.body is required");
  const sent = await deps.collectionsEmailSender.send(ctx, {
    proposalId: row.id,
    to: recipients,
    subject,
    body,
    ...(readString(row.action["thread_id"]).length > 0
      ? { threadId: readString(row.action["thread_id"]) }
      : {}),
  });
  return {
    outcome: "email_sent",
    outbound_reference_ids: [sent.messageId, sent.threadId],
    details: {
      message_id: sent.messageId,
      thread_id: sent.threadId,
      sent_from: sent.sentFrom,
      delivery_status: "sent",
    },
  };
}

async function executeVendorRiskEdit(
  _ctx: ServiceCallContext,
  client: TenantScopedClient,
  row: ProposalRow,
): Promise<DecisionExecutionResult> {
  const vendorId = requiredActionString(row, "counterparty_id");
  const paymentIntentId = readString(row.action["payment_intent_id"]);
  const bankOnFile = readObject(readObject(row.action["comparison"])?.["bank_on_file"]);
  if (bankOnFile === null) {
    throw brainError("request_body_invalid", "comparison.bank_on_file is required");
  }
  await client.query(
    `UPDATE ledger_counterparties
        SET metadata = metadata || jsonb_build_object('bank', $2::jsonb),
            updated_at = now()
      WHERE id = $1
        AND owner_id = current_setting('app.tenant_id', true)`,
    [vendorId, JSON.stringify(bankOnFile)],
  );
  if (paymentIntentId.length > 0) {
    await client.query(
      `UPDATE ledger_payment_intents
          SET destination_counterparty_id = $2,
              updated_at = now()
        WHERE id = $1
          AND owner_id = current_setting('app.tenant_id', true)`,
      [paymentIntentId, vendorId],
    );
  }
  return {
    outcome: "routing_corrected",
    outbound_reference_ids: [],
    details: { vendor_id: vendorId, payment_intent_id: paymentIntentId || null },
  };
}

function isCollectionsEmailProposal(row: ProposalRow): boolean {
  return (
    agentKeyFor(row) === "collections" &&
    (readObject(row.action["draft_email"]) !== null ||
      readString(row.action["type"]) === "send_followup" ||
      readString(row.action["recommended_action"]) === "send_followup")
  );
}

async function emitDecisionExecuted(
  deps: ProposalDecisionServiceDeps,
  ctx: ServiceCallContext,
  actor: ActorContext,
  before: ProposalRow,
  decision: ProposalDecision,
  execution: DecisionExecutionResult,
): Promise<{ id: string; createdAt: string }> {
  const afterState = {
    ...proposalAuditEnvelope(before),
    status: "executed",
    decision,
    outcome: execution.outcome,
  };
  return deps.audit.emit({
    tenantId: ctx.tenantId,
    layer: "agent",
    actor: actor.memberId,
    action: "decision.executed",
    inputs: { proposal_id: before.id, decision },
    outputs: {
      actor: { member_id: actor.memberId, verification: actor.verification },
      ...(ctx.actorReason !== undefined ? { actor_reason: ctx.actorReason } : {}),
      timestamp: new Date().toISOString(),
      outcome: execution.outcome,
      outbound_reference_ids: execution.outbound_reference_ids,
      details: execution.details ?? {},
      proposal_summary: {
        proposing_agent: before.proposing_agent,
        ...proposalActionSnapshot(before),
      },
    },
    beforeState: proposalAuditEnvelope(before),
    afterState,
    idempotencyKey: decisionExecutedAuditKey(before.id, decision, before.status),
  });
}

async function emitInvoiceApproved(
  deps: ProposalDecisionServiceDeps,
  ctx: ServiceCallContext,
  actor: ActorContext,
  before: ProposalRow,
  execution: DecisionExecutionResult,
): Promise<void> {
  const invoiceId = readString(execution.details?.["invoice_id"]);
  if (invoiceId.length === 0) return;
  await deps.audit.emit({
    tenantId: ctx.tenantId,
    layer: "agent",
    actor: actor.memberId,
    action: "invoice.approved",
    inputs: { proposal_id: before.id, invoice_id: invoiceId },
    outputs: {
      actor: { member_id: actor.memberId, verification: actor.verification },
      invoice_id: invoiceId,
      source: "invoice_integrity",
    },
    beforeState: proposalAuditEnvelope(before),
    afterState: {
      ...proposalAuditEnvelope(before),
      invoice_integrity_decision: "approve_as_new",
    },
    idempotencyKey: invoiceApprovedAuditKey(before.id, invoiceId, before.status),
  });
}

function references(
  outcome: string,
  refs: readonly AdapterReference[],
  details?: Record<string, unknown>,
): DecisionExecutionResult {
  return {
    outcome,
    outbound_reference_ids: refs.map((ref) => ref.reference_id),
    ...(details !== undefined ? { details } : {}),
  };
}

function isVendorRiskEditProposal(row: ProposalRow): boolean {
  return (
    agentKeyFor(row) === "vendor_risk" &&
    row.action["comparison"] !== undefined &&
    readString(row.action["counterparty_id"]).length > 0
  );
}

function requiredActionString(row: ProposalRow, key: string): string {
  const value = readString(row.action[key]);
  if (value.length === 0) {
    throw brainError("request_body_invalid", `${key} is required`);
  }
  return value;
}

function invoiceIdFor(row: ProposalRow): string {
  const flagged = readObject(row.action["flagged_invoice"]);
  return (
    readString(flagged?.["id"]) ||
    readString(row.action["invoice_id"]) ||
    readString(row.action["obligation_id"])
  );
}

async function updateInvoiceProjection(
  client: TenantScopedClient,
  invoiceId: string,
  decision: "approve_as_new" | "reject_duplicate" | "hold_and_verify",
): Promise<void> {
  if (invoiceId.length === 0) {
    throw brainError("request_body_invalid", "invoice id is required");
  }
  const status =
    decision === "reject_duplicate"
      ? "cancelled"
      : decision === "hold_and_verify"
        ? "disputed"
        : "sent";
  await client.query(
    `UPDATE ledger_invoices
        SET status = $2,
            metadata = metadata || jsonb_build_object('invoice_integrity_decision', $3::text),
            updated_at = now()
      WHERE id = $1
        AND owner_id = current_setting('app.tenant_id', true)`,
    [invoiceId, status, decision],
  );
  await client.query(
    `UPDATE ledger_obligations
        SET status = CASE
              WHEN $2 = 'reject_duplicate' THEN 'cancelled'
              WHEN $2 = 'hold_and_verify' THEN 'disputed'
              ELSE status
            END,
            metadata = metadata || jsonb_build_object('invoice_integrity_decision', $2::text),
            updated_at = now()
      WHERE id = $1
        AND owner_id = current_setting('app.tenant_id', true)`,
    [invoiceId, decision],
  );
}

function resolveAccountantContact(_pool: Pool, _ctx: ServiceCallContext, row: ProposalRow): string {
  const explicit = readString(row.action["accountant_contact"]);
  if (explicit.length > 0) return explicit;
  return "accountant@example.invalid";
}

function readString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function readRecords(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null && !Array.isArray(item),
  );
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

async function findDecisionAuditId(
  client: TenantScopedClient,
  idempotencyKeyPrefix: string,
): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id
       FROM audit_events
      WHERE left(idempotency_key, length($1)) = $1
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [idempotencyKeyPrefix],
  );
  return rows[0]?.id ?? null;
}

async function findDecisionAuditIdByPrefix(
  pool: Pool,
  tenantId: string,
  idempotencyKeyPrefix: string,
): Promise<string | null> {
  return withTenantScope(pool, tenantId, (client) =>
    findDecisionAuditId(client, idempotencyKeyPrefix),
  );
}
