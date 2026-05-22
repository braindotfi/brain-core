/**
 * AgentService — concrete implementation of IAgentService.propose().
 *
 * Handles non-financial agent proposals (flag_anomaly, suggest_categorization,
 * reconciliation_match, recommend_obligation, etc.). Financial actions go
 * through PaymentIntentService + §6 gate instead.
 *
 * Flow for propose():
 *   1. evaluatePolicy(tenantId, action) — calls PolicyService.evaluateLegacy,
 *      which loads the active policy, runs the VM, and inserts a
 *      policy_decisions row. Returns outcome + policy_version.
 *   2. Map outcome → proposal status:
 *        allow   → "approved"
 *        confirm → "pending"
 *        reject  → "rejected"
 *   3. insertProposal() under tenant scope.
 *   4. Emit agent.action.proposed audit event.
 *   5. Return ProposalRecord.
 */

import {
  brainError,
  newProposalId,
  withTenantScope,
  type AuditEmitter,
  type IAgentService,
  type ProposalInput,
  type ProposalRecord,
  type ServiceCallContext,
} from "@brain/shared";
import type { Pool } from "pg";
import {
  findProposal,
  insertProposal,
  listAgents,
  findAgent,
  insertAgent,
  transitionProposal,
} from "./repository.js";
import type { AgentRecord } from "@brain/shared";
import type { AgentRow } from "./repository.js";

export interface AgentServiceDeps {
  pool: Pool;
  audit: AuditEmitter;
  evaluatePolicy: (
    tenantId: string,
    action: Record<string, unknown>,
  ) => Promise<{
    outcome: "allow" | "confirm" | "reject";
    matched_rule_id: string | null;
    required_approvers: string[];
    trace: unknown[];
    policy_version: number;
  }>;
}

function rowToRecord(row: AgentRow): AgentRecord {
  return {
    id: row.id,
    kind: row.kind,
    role: row.role as AgentRecord["role"],
    display_name: row.display_name,
    scope_hash: row.scope_hash !== null ? row.scope_hash.toString("hex") : null,
    onchain_address: row.onchain_address,
    state: row.state,
    registered_tx: row.registered_tx,
    registered_at: row.registered_at?.toISOString() ?? null,
  };
}

function outcomeToStatus(outcome: "allow" | "confirm" | "reject"): ProposalRecord["status"] {
  switch (outcome) {
    case "allow":
      return "approved";
    case "confirm":
      return "pending";
    case "reject":
      return "rejected";
  }
}

export class AgentService implements IAgentService {
  public constructor(private readonly deps: AgentServiceDeps) {}

  public async propose(
    ctx: ServiceCallContext,
    agentId: string,
    input: ProposalInput,
  ): Promise<ProposalRecord> {
    const action = { ...input.action, kind: input.action["kind"] ?? "agent_action" };

    const policyResult = await this.deps.evaluatePolicy(ctx.tenantId, action);
    const status = outcomeToStatus(policyResult.outcome);
    const id = newProposalId();

    await withTenantScope(this.deps.pool, ctx.tenantId, async (c) => {
      await insertProposal(c, {
        id,
        tenantId: ctx.tenantId,
        proposingAgent: agentId,
        action,
        policyVersion: policyResult.policy_version,
        policyDecision: policyResult.outcome === "confirm" ? "confirm" : policyResult.outcome === "reject" ? "reject" : "allow",
        policyTrace: policyResult.trace as never,
        requiredApprovers: policyResult.required_approvers,
        status,
      });
    });

    await this.deps.audit.emit({
      tenantId: ctx.tenantId,
      layer: "agent",
      actor: agentId,
      action: "agent.action.proposed",
      inputs: { action_kind: String(action["kind"] ?? "agent_action"), proposal_id: id },
      outputs: {
        status,
        outcome: policyResult.outcome,
        matched_rule_id: policyResult.matched_rule_id,
        required_approvers: policyResult.required_approvers,
      },
    });

    return {
      id,
      proposing_agent_id: agentId,
      action,
      policy_decision_id: id,
      status,
      approvers_signed: [],
      created_at: new Date().toISOString(),
    };
  }

  public async list(ctx: ServiceCallContext): Promise<AgentRecord[]> {
    const rows = await withTenantScope(this.deps.pool, ctx.tenantId, (c) => listAgents(c));
    return rows.map(rowToRecord);
  }

  public async get(ctx: ServiceCallContext, agentId: string): Promise<AgentRecord | null> {
    const row = await withTenantScope(this.deps.pool, ctx.tenantId, (c) => findAgent(c, agentId));
    return row !== null ? rowToRecord(row) : null;
  }

  public async register(
    ctx: ServiceCallContext,
    input: Omit<AgentRecord, "state" | "registered_at">,
  ): Promise<AgentRecord> {
    const row = await withTenantScope(this.deps.pool, ctx.tenantId, (c) =>
      insertAgent(c, {
        id: input.id,
        tenant_id: ctx.tenantId,
        kind: input.kind,
        role: input.role,
        display_name: input.display_name,
        scope_hash: input.scope_hash !== null ? Buffer.from(input.scope_hash, "hex") : null,
        onchain_address: input.onchain_address,
        state: "pending_onchain",
        registered_tx: input.registered_tx,
      }),
    );
    return rowToRecord(row);
  }

  public async listActions(
    ctx: ServiceCallContext,
    agentId: string,
    limit: number,
  ): Promise<ProposalRecord[]> {
    const rows = await withTenantScope(this.deps.pool, ctx.tenantId, async (c) => {
      const { rows: r } = await c.query<{
        id: string;
        proposing_agent: string;
        action: Record<string, unknown>;
        status: ProposalRecord["status"];
        approvers_signed: string[];
        created_at: Date;
      }>(
        `SELECT id, proposing_agent, action, status, approvers_signed, created_at
           FROM proposals WHERE proposing_agent = $1
           ORDER BY created_at DESC LIMIT $2`,
        [agentId, limit],
      );
      return r;
    });
    return rows.map((r) => ({
      id: r.id,
      proposing_agent_id: r.proposing_agent,
      action: r.action,
      policy_decision_id: r.id,
      status: r.status,
      approvers_signed: r.approvers_signed,
      created_at: r.created_at.toISOString(),
    }));
  }

  public async approve(ctx: ServiceCallContext, proposalId: string): Promise<ProposalRecord> {
    const row = await withTenantScope(this.deps.pool, ctx.tenantId, async (c) => {
      const existing = await findProposal(c, proposalId);
      if (existing === null) {
        throw brainError("execution_proposal_not_found", `proposal ${proposalId} not found`);
      }
      return transitionProposal(c, proposalId, existing.status, "approved");
    });
    return {
      id: row.id,
      proposing_agent_id: row.proposing_agent,
      action: row.action,
      policy_decision_id: row.id,
      status: row.status,
      approvers_signed: row.approvers_signed,
      created_at: row.created_at.toISOString(),
    };
  }

  public async reject(
    ctx: ServiceCallContext,
    proposalId: string,
    _reason?: string,
  ): Promise<ProposalRecord> {
    const row = await withTenantScope(this.deps.pool, ctx.tenantId, async (c) => {
      const existing = await findProposal(c, proposalId);
      if (existing === null) {
        throw brainError("execution_proposal_not_found", `proposal ${proposalId} not found`);
      }
      return transitionProposal(c, proposalId, existing.status, "rejected");
    });
    return {
      id: row.id,
      proposing_agent_id: row.proposing_agent,
      action: row.action,
      policy_decision_id: row.id,
      status: row.status,
      approvers_signed: row.approvers_signed,
      created_at: row.created_at.toISOString(),
    };
  }

  public async escalate(ctx: ServiceCallContext, proposalId: string, note?: string): Promise<void> {
    await this.deps.audit.emit({
      tenantId: ctx.tenantId,
      layer: "agent",
      actor: ctx.actor,
      action: "agent.action.escalated",
      inputs: { proposal_id: proposalId, note: note ?? null },
      outputs: {},
    });
  }
}
