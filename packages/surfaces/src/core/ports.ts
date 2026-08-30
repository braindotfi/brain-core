import type { Proposal, ActorId, Decision } from "../proposal/schema.js";

/**
 * The boundary between this surface package and brain-core.
 *
 * This package never reaches into brain-core directly. brain-core (or a thin
 * binding in brain-core) implements these ports and injects them. That
 * keeps this package publishable-shaped and keeps brain-core as the single
 * source of truth for policy, audit, and gated execution.
 */

/** Resolves a surface-native identity into a Brain actor with roles. */
export interface IdentityResolver {
  /**
   * Map an external identity (Slack user id, Teams aad object id, verified email)
   * to a Brain actor scoped to a tenant. Returns null if the identity is not
   * provisioned for this tenant. Never assume workspace-level trust.
   */
  resolve(input: {
    tenantId: string;
    surface: SurfaceName;
    externalId: string;
  }): Promise<ResolvedActor | null>;
}

export interface ResolvedActor {
  actorId: ActorId;
  roles: string[];
  /** Safe human-readable fallback when the provider user id is unavailable. */
  displayName?: string | undefined;
  /** Server-resolved email, used for actor-payee checks when available. */
  email?: string | undefined;
}

/**
 * Re-checks policy at decision time. Rendering policy at emit time is not enough.
 * The approver's authority must be verified on the click, against the Policy
 * layer, so the surface can never become a policy-bypass path.
 */
export interface PolicyGate {
  canDecide(input: {
    proposal: Proposal;
    actor: ResolvedActor;
    decision: Exclude<Decision, "pending" | "expired">;
  }): Promise<PolicyVerdict>;
}

export interface PolicyVerdict {
  allowed: boolean;
  /** Human-readable reason when not allowed, surfaced back to the approver. */
  reason?: string;
  /** The approver role that policy accepted for this decision. */
  approverRole?: string;
}

/** Writes the immutable decision record into the brain-core Audit layer. */
export interface AuditAnchor {
  record(event: AuditEvent): Promise<void>;
}

export interface AuditEvent {
  proposalId: string;
  tenantId: string;
  /** The content hash captured at emit time. Proves what was shown. */
  contentHash: string;
  surface: SurfaceName;
  actorId: ActorId;
  decision: Decision;
  /** ISO timestamp of the decision. */
  decidedAt: string;
  /** Any extra surface context, for example Slack channel or message ts. */
  context?: Record<string, string> | undefined;
}

/**
 * Hands an approved proposal to core's canonical execution service. The
 * adapter does not construct rail payloads or bypass the section 6 gate.
 */
export interface ExecutionHandoff {
  enqueue(input: {
    proposal: Proposal;
    actorId: ActorId;
    externalActorId: string;
    surface: SurfaceName;
  }): Promise<void>;
}

/**
 * Records the approval signature that contributes to quorum.
 * ApprovalService calls this only after the decision audit anchor has been
 * written, so a quorum-changing signature cannot precede its audit record.
 */
export interface ApprovalRecorder {
  recordApproval(input: {
    proposal: Proposal;
    actorId: ActorId;
    externalActorId: string;
    surface: SurfaceName;
    approverRole?: string | undefined;
  }): Promise<{ quorumMet: boolean }>;
}

export interface TerminalDecisionInput {
  proposalId: string;
  tenantId: string;
  decision: Exclude<Decision, "pending" | "expired">;
  actorId: ActorId;
  decidedAt: string;
  approverRole?: string | undefined;
  context?: Record<string, string> | undefined;
}

export interface TerminalDecisionRecord extends TerminalDecisionInput {
  applied: boolean;
}

export type DecisionClaim =
  | { status: "claimed" }
  | { status: "already_decided"; record: TerminalDecisionRecord };

/**
 * Atomic terminal-decision store. This is separate from Audit: the approval
 * pipeline claims the terminal decision to prevent races, writes Audit, then
 * hands off execution. Implementations should claim idempotently by
 * tenantId/proposalId.
 */
export interface ApprovalDecisionStore {
  claimTerminal(record: TerminalDecisionInput): Promise<DecisionClaim>;
  markTerminalApplied(record: TerminalDecisionInput): Promise<void>;
}

export const SURFACE_NAMES = ["slack", "teams", "email"] as const;
export type SurfaceName = (typeof SURFACE_NAMES)[number];

/** Everything the dispatcher and adapters need from brain-core, injected once. */
export interface BrainCorePorts {
  identity: IdentityResolver;
  policy: PolicyGate;
  audit: AuditAnchor;
  approvals: ApprovalRecorder;
  execution: ExecutionHandoff;
  decisions: ApprovalDecisionStore;
}
