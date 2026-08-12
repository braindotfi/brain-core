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
import type { AgentAuthority } from "@brain/schemas";
import {
  findProposal,
  findPendingCollectionsProposalForInvoice,
  insertProposal,
  listAgents,
  lockCollectionsProposalForInvoice,
  findAgent,
  refreshCollectionsProposal,
  insertAgent,
  markAgentRegistered,
  transitionProposal,
} from "./repository.js";
import type { AgentRecord } from "@brain/shared";
import type { AgentRow } from "./repository.js";
import type { AgentRegistrationRelayer } from "./registration-relayer.js";

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
  resolveAgentAuthority?: (
    ctx: ServiceCallContext,
    agentId: string,
  ) => Promise<AgentAuthority | null> | AgentAuthority | null;
  /**
   * On-chain registration relayer (RFC 0002 Phase C). Optional: when absent or
   * unconfigured, {@link AgentService.confirmRegistration} fails closed and the
   * agent stays `pending_onchain` (never auto-activated). Wiring a real
   * KMS-backed relayer is deferred live-wiring.
   */
  relayer?: AgentRegistrationRelayer;
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

/**
 * Map a policy outcome to a proposal status. Exported: reused by the
 * Collections proposal reconciler, which re-evaluates policy for a refreshed
 * action outside of `propose()` and must apply the identical mapping.
 */
export function outcomeToStatus(
  outcome: "allow" | "confirm" | "reject",
  authority: AgentAuthority,
): ProposalRecord["status"] {
  if (authority === "notify_only" && outcome !== "reject") {
    return "pending";
  }
  switch (outcome) {
    case "allow":
      return "approved";
    case "confirm":
      return "pending";
    case "reject":
      return "rejected";
  }
}

function collectionsInvoiceId(agentId: string, action: Record<string, unknown>): string | null {
  if (agentId !== "collections") return null;
  const invoiceId = action["invoice_id"];
  return typeof invoiceId === "string" && invoiceId.length > 0 ? invoiceId : null;
}

export class AgentService implements IAgentService {
  public constructor(private readonly deps: AgentServiceDeps) {}

  public async propose(
    ctx: ServiceCallContext,
    agentId: string,
    input: ProposalInput,
  ): Promise<ProposalRecord> {
    const authority = (await this.deps.resolveAgentAuthority?.(ctx, agentId)) ?? "notify_only";
    const action: Record<string, unknown> = {
      ...input.action,
      kind: input.action["kind"] ?? "agent_action",
      mode: authority === "notify_only" ? "notify_only" : "propose",
    };

    const policyResult = await this.deps.evaluatePolicy(ctx.tenantId, action);
    const status = outcomeToStatus(policyResult.outcome, authority);
    const id = newProposalId();

    const invoiceId = collectionsInvoiceId(agentId, action);
    let proposalId = id;
    let refreshed = false;
    let previousAction: Record<string, unknown> | null = null;

    await withTenantScope(this.deps.pool, ctx.tenantId, async (c) => {
      if (invoiceId !== null) {
        await lockCollectionsProposalForInvoice(c, ctx.tenantId, invoiceId);
        const existing = await findPendingCollectionsProposalForInvoice(c, invoiceId);
        if (existing !== null) {
          previousAction = existing.action;
          await refreshCollectionsProposal(c, existing, {
            action,
            policyVersion: policyResult.policy_version,
            policyDecision: policyResult.outcome,
            policyTrace: policyResult.trace as never,
            requiredApprovers: policyResult.required_approvers,
            status,
          });
          proposalId = existing.id;
          refreshed = true;
          return;
        }
      }
      await insertProposal(c, {
        id,
        tenantId: ctx.tenantId,
        proposingAgent: agentId,
        action,
        policyVersion: policyResult.policy_version,
        policyDecision: policyResult.outcome,
        policyTrace: policyResult.trace as never,
        requiredApprovers: policyResult.required_approvers,
        status,
      });
    });

    await this.deps.audit.emit({
      tenantId: ctx.tenantId,
      layer: "agent",
      actor: agentId,
      action: refreshed ? "agent.action.refreshed" : "agent.action.proposed",
      ...(policyResult.matched_rule_id !== null
        ? { policyCheckId: policyResult.matched_rule_id }
        : {}),
      outcome: policyResult.outcome,
      inputs: {
        action_kind: String(action["kind"] ?? "agent_action"),
        proposal_id: proposalId,
        ...(invoiceId !== null ? { invoice_id: invoiceId } : {}),
      },
      outputs: {
        status,
        outcome: policyResult.outcome,
        matched_rule_id: policyResult.matched_rule_id,
        required_approvers: policyResult.required_approvers,
        ...(refreshed
          ? {
              refreshed: true,
              previous_days_overdue: previousAction?.["days_overdue"] ?? null,
              days_overdue: action["days_overdue"] ?? null,
            }
          : {}),
      },
    });

    return {
      id: proposalId,
      proposing_agent_id: agentId,
      action,
      policy_decision_id: proposalId,
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

  /**
   * `attestationMode` defaults to "onchain_custodial" -- the pre-existing
   * behavior of always requiring BrainMCPAgentRegistry confirmation before
   * `active`. Passing "none" (RFC 0002 Phase C, increment 1: tier-1
   * unattested) registers the agent already `active`, with `registered_at`
   * stamped now and no `registered_tx` -- there is no on-chain confirmation
   * to wait for.
   */
  public async register(
    ctx: ServiceCallContext,
    input: Omit<AgentRecord, "state" | "registered_at">,
    attestationMode: string = "onchain_custodial",
  ): Promise<AgentRecord> {
    const isUnattested = attestationMode === "none";
    const row = await withTenantScope(this.deps.pool, ctx.tenantId, (c) =>
      insertAgent(c, {
        id: input.id,
        tenant_id: ctx.tenantId,
        kind: input.kind,
        role: input.role,
        display_name: input.display_name,
        scope_hash: input.scope_hash !== null ? Buffer.from(input.scope_hash, "hex") : null,
        onchain_address: input.onchain_address,
        state: isUnattested ? "active" : "pending_onchain",
        registered_tx: isUnattested ? null : input.registered_tx,
        attestation_mode: attestationMode,
        ...(isUnattested ? { registeredAt: new Date() } : {}),
      }),
    );
    return rowToRecord(row);
  }

  /**
   * Confirm a `pending_onchain` agent's BrainMCPAgentRegistry attestation and
   * promote it to `active` (RFC 0002 Phase C). Intended to be driven by an async
   * worker after registration.
   *
   * FAIL-CLOSED: if no relayer is configured (or its signer is unwired), this
   * throws and the agent stays `pending_onchain` — it is never auto-activated.
   * The attestation tx is submitted BEFORE the state flip, so the row only
   * reaches `active` once the on-chain proof exists (recorded as registered_tx).
   */
  public async confirmRegistration(ctx: ServiceCallContext, agentId: string): Promise<AgentRecord> {
    const existing = await withTenantScope(this.deps.pool, ctx.tenantId, (c) =>
      findAgent(c, agentId),
    );
    if (existing === null) {
      throw brainError("agent_not_registered", `agent ${agentId} not found`);
    }
    if (existing.state !== "pending_onchain") {
      throw brainError(
        "agent_proposal_invalid_state",
        `agent ${agentId} is ${existing.state}, not pending_onchain`,
      );
    }
    if (this.deps.relayer === undefined || !this.deps.relayer.configured) {
      // No real on-chain relayer wired — fail closed, leave the agent pending.
      throw brainError(
        "agent_rail_unavailable",
        "agent on-chain registration relayer is not configured",
      );
    }

    const { txHash } = await this.deps.relayer.submitRegistration({
      agentId,
      tenantId: ctx.tenantId,
      onchainAddress: existing.onchain_address ?? "",
      scopeHash: existing.scope_hash !== null ? existing.scope_hash.toString("hex") : "",
    });

    const row = await withTenantScope(this.deps.pool, ctx.tenantId, (c) =>
      markAgentRegistered(c, agentId, txHash),
    );
    if (row === null) {
      // Lost a race — another relay already promoted it. Return current state.
      const current = await withTenantScope(this.deps.pool, ctx.tenantId, (c) =>
        findAgent(c, agentId),
      );
      if (current === null) throw brainError("agent_not_registered", `agent ${agentId} not found`);
      return rowToRecord(current);
    }

    await this.deps.audit.emit({
      tenantId: ctx.tenantId,
      layer: "agent",
      actor: ctx.actor,
      action: "agent.onchain_confirmed",
      inputs: { agent_id: agentId },
      outputs: { state: "active", registered_tx: txHash },
    });

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
