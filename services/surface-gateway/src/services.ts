import type { Pool } from "pg";
import type { ActorId, Decision, Proposal, ResolvedActor, SurfaceName } from "@brain/surfaces";
import type { AuditLog, CoreServices, ExecutionQueue, PolicyEngine } from "@brain/core";
import { ApprovalService as ExecutionApprovalService, findAgent, findUser } from "@brain/execution";
import { evaluate, getActive } from "@brain/policy";
import type { Decision as PolicyDecision, PolicyDocument } from "@brain/policy";
import type { AuditEmitter, ServiceCallContext } from "@brain/shared";
import { withTenantScope } from "@brain/shared";
import {
  PostgresSurfaceDecisionStore,
  PostgresSurfaceIdentityStore,
  PostgresSurfaceProposalStore,
} from "./storage.js";

type TerminalDecision = Exclude<Decision, "pending" | "expired">;

export interface SurfaceGatewayServiceOptions {
  pool: Pool;
  auditPool: Pool;
  resolverPool?: Pool | undefined;
  audit: AuditEmitter;
}

export function buildSurfaceGatewayServices(options: SurfaceGatewayServiceOptions): {
  services: CoreServices;
  proposals: PostgresSurfaceProposalStore;
} {
  const proposalStore = new PostgresSurfaceProposalStore(options.pool);
  const approvals = new ExecutionApprovalService({
    pool: options.pool,
    audit: options.audit,
    resolveRole: resolveRole(options.pool),
    isApproverActive: isApproverActive(options.pool),
    resolveSubjectOwnerTenant: async (ctx, subject) => {
      if (subject.type !== "proposal") return null;
      const proposal = await proposalStore.load({ tenantId: ctx.tenantId, proposalId: subject.id });
      return proposal?.tenantId ?? null;
    },
    resolveActivePolicyVersion: async (ctx) =>
      withTenantScope(options.pool, ctx.tenantId, async (c) => {
        const active = await getActive(c);
        return active?.version ?? null;
      }),
  });

  const services: CoreServices = {
    identity: new PostgresSurfaceIdentityStore(options.pool, options.resolverPool ?? options.pool),
    policy: new SurfacePolicyEngine(options.pool),
    audit: new SurfaceAuditLog(options.audit),
    approvals: new SurfaceApprovalRecorder(approvals, options.pool),
    execution: new SurfaceExecutionQueue(),
    decisions: new PostgresSurfaceDecisionStore(options.pool),
    proposals: proposalStore,
  };
  return { services, proposals: proposalStore };
}

export class SurfacePolicyEngine implements PolicyEngine {
  public constructor(private readonly pool: Pool) {}

  public async evaluateDecision(input: {
    proposal: Proposal;
    actor: ResolvedActor;
    decision: TerminalDecision;
  }): Promise<{
    allowed: boolean;
    reason?: string;
    approverRole?: string;
  }> {
    const activeDecision = await withTenantScope(this.pool, input.proposal.tenantId, async (c) => {
      const active = await getActive(c);
      if (active === null) return null;
      return evaluateForActorRoles(active.content, input.proposal, input.actor.roles);
    });

    if (activeDecision === null) {
      return { allowed: false, reason: "No active tenant policy" };
    }
    if (activeDecision.outcome === "reject") {
      return { allowed: false, reason: "Current tenant policy rejects this action" };
    }

    const requiredRoles =
      activeDecision.required_approvers.length > 0
        ? activeDecision.required_approvers
        : input.proposal.policy.approverRoles;
    const actorRole = firstMatchingRole(input.actor.roles, requiredRoles);
    if (actorRole === null) {
      return { allowed: false, reason: "Actor lacks an approver role for this proposal" };
    }

    if (input.decision === "rejected") {
      return { allowed: true, approverRole: actorRole };
    }

    return { allowed: true, approverRole: actorRole };
  }
}

export class SurfaceAuditLog implements AuditLog {
  public constructor(private readonly audit: AuditEmitter) {}

  public async append(event: {
    proposalId: string;
    tenantId: string;
    contentHash: string;
    surface: SurfaceName;
    actorId: ActorId;
    decision: Decision;
    decidedAt: string;
    context?: Record<string, string> | undefined;
  }): Promise<void> {
    await this.audit.emit({
      tenantId: event.tenantId,
      layer: "agent",
      actor: event.actorId,
      action: "surface.approval.decided",
      inputs: {
        proposal_id: event.proposalId,
        surface: event.surface,
        content_hash: event.contentHash,
        context: event.context ?? {},
      },
      outputs: {
        decision: event.decision,
        decided_at: event.decidedAt,
      },
      idempotencyKey: surfaceDecisionAuditKey(event),
    });
  }
}

export class SurfaceApprovalRecorder {
  public constructor(
    private readonly approvals: ExecutionApprovalService,
    private readonly pool?: Pool | undefined,
  ) {}

  public async recordApproval(input: {
    proposal: Proposal;
    actorId: ActorId;
    surface: SurfaceName;
    approverRole?: string | undefined;
  }): Promise<{ quorumMet: boolean }> {
    const ctx = context(input.proposal.tenantId, input.actorId);
    const requiredRoles = await this.requiredRoles(input.proposal);
    const result = await this.approvals.signAndCheckRequiredApprovals(
      ctx,
      { type: "proposal", id: input.proposal.id },
      requiredRoles,
      input.approverRole,
    );
    return { quorumMet: result.quorumMet };
  }

  private async requiredRoles(proposal: Proposal): Promise<string[]> {
    if (this.pool === undefined) return proposal.policy.approverRoles;
    return withTenantScope(this.pool, proposal.tenantId, async (c) => {
      const active = await getActive(c);
      if (active === null) return proposal.policy.approverRoles;
      const activeDecision = evaluateForActorRoles(
        active.content,
        proposal,
        proposal.policy.approverRoles,
      );
      return activeDecision.required_approvers.length > 0
        ? activeDecision.required_approvers
        : proposal.policy.approverRoles;
    });
  }
}

export class SurfaceExecutionQueue implements ExecutionQueue {
  public async enqueueIdempotent(_input: {
    proposalId: string;
    proposal: Proposal;
    actorId: ActorId;
  }): Promise<void> {
    return;
  }
}

function resolveRole(
  pool: Pool,
): (ctx: ServiceCallContext, principalId: string) => Promise<string | null> {
  return async (ctx, principalId) =>
    withTenantScope(pool, ctx.tenantId, async (c) => {
      const agent = await findAgent(c, principalId);
      if (agent !== null) return agent.role;
      const user = await findUser(c, principalId);
      return user?.role ?? null;
    });
}

function isApproverActive(
  pool: Pool,
): (ctx: ServiceCallContext, principalId: string) => Promise<boolean> {
  return async (ctx, principalId) =>
    withTenantScope(pool, ctx.tenantId, async (c) => {
      const agent = await findAgent(c, principalId);
      if (agent !== null) return agent.state === "active";
      const user = await findUser(c, principalId);
      return user?.status === "active";
    });
}

function context(tenantId: string, actor: string): ServiceCallContext {
  return { tenantId, actor, principalType: "user", scopes: [] };
}

function firstMatchingRole(
  actorRoles: readonly string[],
  requiredRoles: readonly string[],
): string | null {
  // In the policy DSL, signer is a sentinel for any eligible held approver role.
  // A roleless actor is never eligible.
  if (requiredRoles.includes("signer")) return actorRoles[0] ?? null;
  const required = new Set(requiredRoles);
  return actorRoles.find((role) => required.has(role)) ?? null;
}

function surfaceAmount(proposal: Proposal): { currency: string; value: string } | null {
  const amount = proposal.action.amount;
  if (amount === undefined) return null;
  return { currency: amount.currency, value: String(amount.minorUnits) };
}

function surfaceRiskLevel(proposal: Proposal): "low" | "medium" | "high" | "critical" {
  if (proposal.severity === "critical") return "critical";
  if (proposal.severity === "warning") return "medium";
  return "low";
}

function evaluateForActorRoles(
  policy: PolicyDocument,
  proposal: Proposal,
  roles: readonly string[],
): PolicyDecision {
  const candidates = roles.length > 0 ? roles : [null];
  let first: PolicyDecision | null = null;
  for (const role of candidates) {
    const decision = evaluate(policy, {
      kind: "agent_action",
      counterparty_id: null,
      amount: surfaceAmount(proposal),
      agent_role: role,
      action_id: proposal.action.handoff,
      risk_level: surfaceRiskLevel(proposal),
      timestamp: new Date(),
    });
    first ??= decision;
    if (decision.outcome !== "reject") return decision;
  }
  return first!;
}

function surfaceDecisionAuditKey(event: {
  tenantId: string;
  proposalId: string;
  decision: Decision;
  actorId: ActorId;
  contentHash: string;
}): string {
  return [
    "surface-decision",
    event.tenantId,
    event.proposalId,
    event.decision,
    event.actorId,
    event.contentHash,
  ].join(":");
}
