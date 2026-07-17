import {
  brainError,
  isBrainId,
  requireScope,
  withTenantScope,
  type AuditEmitter,
  type Scope,
  type ServiceCallContext,
  type TenantScopedClient,
} from "@brain/shared";
import type { Pool } from "pg";
import type { PaymentIntentService } from "../payment-intents/PaymentIntentService.js";
import type { ActorResolver } from "../members/ActorResolver.js";
import type { ActorContext } from "../members/types.js";
import { isApprovalCapableRole } from "../members/authorizeApproval.js";
import { assertProposalTransition, type ProposalState } from "../state-machines.js";
import type { ProposalRow } from "../repository.js";
import { getProposal } from "./read-model.js";

export const PROPOSAL_DECISIONS = ["approve", "reject", "acknowledge", "undo"] as const;
export type ProposalDecision = (typeof PROPOSAL_DECISIONS)[number];
const SCOPE_APPROVE: Scope = "payment_intent:approve";

export interface ProposalDecisionResult {
  id: string;
  decision: ProposalDecision;
  status: string;
  audit_id: string | null;
  payment_intent_id: string | null;
}

export interface ProposalDecisionServiceDeps {
  pool: Pool;
  audit: AuditEmitter;
  actorResolver: ActorResolver;
  paymentIntents: PaymentIntentService;
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
      return this.decideMoneyPath(ctx, proposal.payment_intent_id, decision, proposal.status);
    }
    return this.decideAgentProposal(ctx, proposalId, decision);
  }

  private async decideMoneyPath(
    ctx: ServiceCallContext,
    paymentIntentId: string,
    decision: ProposalDecision,
    beforeStatus: string,
  ): Promise<ProposalDecisionResult> {
    if (decision !== "approve" && decision !== "reject") {
      throw brainError(
        "execution_proposal_invalid_state",
        `${decision} is not valid for money-path proposals`,
      );
    }
    requireScope(ctx.scopes ?? [], SCOPE_APPROVE);
    let actor: ActorContext;
    let updated: { status: string };
    if (decision === "approve") {
      updated = await this.deps.paymentIntents.approve(ctx, paymentIntentId);
      actor = await this.resolveSessionActor(ctx);
    } else {
      actor = await this.resolveSessionActor(ctx);
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
      updated = await this.deps.paymentIntents.reject(ctx, paymentIntentId);
    }
    const audit = await this.deps.audit.emit({
      tenantId: ctx.tenantId,
      layer: "agent",
      actor: actor.memberId,
      action: "proposal.decided",
      inputs: { proposal_id: paymentIntentId, decision },
      outputs: { status: updated.status, payment_intent_id: paymentIntentId },
      beforeState: { id: paymentIntentId, status: beforeStatus },
      afterState: { id: paymentIntentId, status: updated.status },
      idempotencyKey: proposalDecisionAuditKey(paymentIntentId, decision, beforeStatus),
    });
    return {
      id: paymentIntentId,
      decision,
      status: updated.status,
      audit_id: audit.id,
      payment_intent_id: paymentIntentId,
    };
  }

  private async decideAgentProposal(
    ctx: ServiceCallContext,
    proposalId: string,
    decision: ProposalDecision,
  ): Promise<ProposalDecisionResult> {
    const actor = await this.resolveSessionActor(ctx);
    return withTenantScope(this.deps.pool, ctx.tenantId, async (client) => {
      const before = await findProposalForUpdate(client, proposalId);
      if (before === null) {
        throw brainError("execution_proposal_not_found", "no such proposal");
      }
      assertAgentDecisionAuthority(actor, decision);
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

  private async resolveSessionActor(ctx: ServiceCallContext): Promise<ActorContext> {
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

function proposalAuditEnvelope(row: ProposalRow): Record<string, unknown> {
  return {
    id: row.id,
    proposing_agent: row.proposing_agent,
    status: row.status,
    policy_decision: row.policy_decision,
    required_approvers: row.required_approvers,
    approvers_signed: row.approvers_signed,
  };
}

type TargetStatus =
  | { status: ProposalState; idempotent: false }
  | { status: ProposalState; idempotent: true };

function targetStatusForDecision(row: ProposalRow, decision: ProposalDecision): TargetStatus {
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
      // BC-3 owns whether an agent may self-assert notify_only mode. This
      // decision endpoint only enforces the stored canonical proposal mode.
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
): Promise<ProposalRow> {
  const { rows } = await client.query<ProposalRow>(
    `UPDATE proposals
        SET status = $1
      WHERE id = $2 AND status = $3
        AND tenant_id = current_setting('app.tenant_id', true)
      RETURNING *`,
    [to, id, from],
  );
  const row = rows[0];
  if (row === undefined) {
    throw brainError("execution_proposal_invalid_state", "proposal moved during decision");
  }
  return row;
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
