import type { Proposal, ActorId, Decision, SurfaceName } from "@brain/surfaces";

/**
 * Interfaces for the brain-core capabilities the surface bindings call into.
 *
 * These represent services that ALREADY EXIST inside brain-core: the RLS-scoped
 * identity store, the policy engine that owns the 23 gates, the Audit anchor
 * writer, the execution queue, and proposal storage. The bindings in
 * ../bindings depend only on these interfaces, so wiring to the real services is
 * a matter of providing the concrete implementations at the composition root.
 *
 * TODO(brain-core): replace these with imports of the real internal services.
 * Do not reimplement policy or audit logic here. The bindings are adapters, not
 * a second source of truth.
 */

/** RLS- and tenant-scoped identity. Maps an external identity to a Brain actor. */
export interface TenantIdentityStore {
  lookupActor(input: {
    tenantId: string;
    surface: SurfaceName;
    externalId: string;
  }): Promise<{ actorId: ActorId; roles: string[] } | null>;
}

/** The existing policy engine. Owns the gates and dual-approval bookkeeping. */
export interface PolicyEngine {
  evaluateDecision(input: {
    proposal: Proposal;
    actor: { actorId: ActorId; roles: string[] };
    decision: "approved" | "rejected";
  }): Promise<{
    allowed: boolean;
    reason?: string;
    awaitingSecondApproval?: boolean;
    approverRole?: string;
  }>;
}

/** Immutable audit log. Append only. */
export interface AuditLog {
  append(event: {
    proposalId: string;
    tenantId: string;
    contentHash: string;
    surface: SurfaceName;
    actorId: ActorId;
    decision: Decision;
    decidedAt: string;
    context?: Record<string, string> | undefined;
  }): Promise<void>;
}

/** Execution queue. Must be idempotent on proposal id. Never moves funds itself. */
export interface ExecutionQueue {
  enqueueIdempotent(input: {
    proposalId: string;
    proposal: Proposal;
    actorId: ActorId;
  }): Promise<void>;
}

export interface ApprovalRecorder {
  recordApproval(input: {
    proposal: Proposal;
    actorId: ActorId;
    surface: SurfaceName;
    approverRole?: string | undefined;
  }): Promise<void>;
}

export interface DecisionStore {
  claimTerminal(input: {
    tenantId: string;
    proposalId: string;
    decision: Exclude<Decision, "pending" | "expired">;
    actorId: ActorId;
    decidedAt: string;
    approverRole?: string | undefined;
  }): Promise<
    | { status: "claimed" }
    | {
        status: "already_decided";
        record: {
          tenantId: string;
          proposalId: string;
          decision: Exclude<Decision, "pending" | "expired">;
          actorId: ActorId;
          decidedAt: string;
          approverRole?: string | undefined;
          applied: boolean;
          context?: Record<string, string> | undefined;
        };
      }
  >;
  markTerminalApplied(input: {
    tenantId: string;
    proposalId: string;
    decision: Exclude<Decision, "pending" | "expired">;
    actorId: ActorId;
    decidedAt: string;
    context?: Record<string, string> | undefined;
  }): Promise<void>;
}

/** Canonical proposal storage. Returns the exact dispatched object, hash intact. */
export interface ProposalStore {
  load(input: { tenantId: string; proposalId: string }): Promise<Proposal | null>;
  /** Persist a delivered surface message ref so cards can be updated later. */
  saveDeliveredRef(input: {
    tenantId: string;
    proposalId: string;
    surface: SurfaceName;
    target: string;
    ref: string;
  }): Promise<void>;
}

/** Everything the composition root needs from existing brain-core internals. */
export interface CoreServices {
  identity: TenantIdentityStore;
  policy: PolicyEngine;
  audit: AuditLog;
  approvals: ApprovalRecorder;
  execution: ExecutionQueue;
  decisions: DecisionStore;
  proposals: ProposalStore;
}
