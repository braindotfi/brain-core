import type { Proposal, ActorId, Decision } from "../proposal/schema.js";

/**
 * The boundary between this surface package and brain-core.
 *
 * This package never reaches into brain-core directly. brain-core (or a thin
 * binding in brain-core) implements these four ports and injects them. That
 * keeps this package publishable-shaped, keeps brain-core as the single source
 * of truth for policy and audit, and keeps the propose-only line clean: nothing
 * here can move money, because no port exposes a way to.
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
  /** True when this approval satisfies a gate but a second approver is still required. */
  awaitingSecondApproval?: boolean;
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
 * Hands an approved proposal to the customer's execution rail. Brain does not
 * execute. This port enqueues the handoff and returns. The downstream system
 * (ERP, bank portal, email send) performs the action under its own credentials.
 */
export interface ExecutionHandoff {
  enqueue(input: { proposal: Proposal; actorId: ActorId }): Promise<void>;
}

export interface TerminalDecisionInput {
  proposalId: string;
  tenantId: string;
  decision: Exclude<Decision, "pending" | "expired">;
  actorId: ActorId;
  decidedAt: string;
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
  execution: ExecutionHandoff;
  decisions: ApprovalDecisionStore;
}
