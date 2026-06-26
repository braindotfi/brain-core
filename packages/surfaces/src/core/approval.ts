import type { Proposal } from "../proposal/schema.js";
import type { BrainCorePorts } from "./ports.js";
import type { IncomingDecision } from "./types.js";
import type { SurfaceRegistry } from "./registry.js";
import { isExpired } from "./dispatcher.js";

export type ApprovalOutcome =
  | { status: "applied"; decision: "approved" | "rejected"; actorLabel: string }
  | { status: "awaiting_second_approval"; actorLabel: string }
  | {
      status: "already_decided";
      decision: "approved" | "rejected";
      actorLabel: string;
      decidedAt: string;
    }
  | { status: "denied"; reason: string }
  | { status: "expired" }
  | { status: "unknown_actor" };

/**
 * The single approval pipeline shared by Slack, Teams, and email.
 *
 * Order is deliberate and must not be reordered:
 *   1. expiry check        a stale proposal can never be approved
 *   2. identity resolution surface identity must map to a real Brain actor
 *   3. policy re-check      authority is verified at click time, not emit time
 *   4. audit anchor         the decision plus content hash is recorded first
 *   5. execution handoff    only after audit, and only for approvals
 *   6. surface update       best-effort, never gates the decision
 *
 * Steps 1 to 4 must all succeed before anything leaves Brain. This is what keeps
 * a surface from becoming a policy-bypass or an unlogged-approval path.
 */
export class ApprovalService {
  constructor(
    private readonly ports: BrainCorePorts,
    private readonly surfaces: SurfaceRegistry,
    /** Loads the canonical proposal by id and tenant from brain-core storage. */
    private readonly loadProposal: (input: {
      tenantId: string;
      proposalId: string;
    }) => Promise<Proposal | null>,
  ) {}

  async handle(
    incoming: IncomingDecision,
    /** The delivered message ref, when the surface can supply it, for updates. */
    deliveredRef?: string,
  ): Promise<ApprovalOutcome> {
    const proposal = await this.loadProposal({
      tenantId: incoming.tenantId,
      proposalId: incoming.proposalId,
    });
    if (!proposal) return { status: "unknown_actor" };

    // 1. expiry
    if (isExpired(proposal)) return { status: "expired" };

    // 2. identity
    const actor = await this.ports.identity.resolve({
      tenantId: incoming.tenantId,
      surface: incoming.surface,
      externalId: incoming.externalActorId,
    });
    if (!actor) return { status: "unknown_actor" };

    // 3. policy re-check at decision time
    const verdict = await this.ports.policy.canDecide({
      proposal,
      actor,
      decision: incoming.decision,
    });
    if (!verdict.allowed) {
      return { status: "denied", reason: verdict.reason ?? "Not authorized" };
    }

    const decidedAt = new Date().toISOString();
    const actorLabel = actor.actorId;

    if (!verdict.awaitingSecondApproval) {
      const claim = await this.ports.decisions.claimTerminal({
        proposalId: proposal.id,
        tenantId: proposal.tenantId,
        decision: incoming.decision,
        actorId: actor.actorId,
        decidedAt,
      });
      if (claim.status === "already_decided") {
        return {
          status: "already_decided",
          decision: claim.record.decision,
          actorLabel: claim.record.actorId,
          decidedAt: claim.record.decidedAt,
        };
      }
    }

    // 4. audit anchor, before any handoff
    await this.ports.audit.record({
      proposalId: proposal.id,
      tenantId: proposal.tenantId,
      contentHash: proposal.contentHash ?? "",
      surface: incoming.surface,
      actorId: actor.actorId,
      decision: incoming.decision,
      decidedAt,
      context: incoming.context,
    });

    if (verdict.awaitingSecondApproval) {
      return { status: "awaiting_second_approval", actorLabel };
    }

    await this.ports.decisions.markTerminalApplied({
      proposalId: proposal.id,
      tenantId: proposal.tenantId,
      decision: incoming.decision,
      actorId: actor.actorId,
      decidedAt,
    });

    // 5. execution handoff, approvals only, never inside Brain
    if (incoming.decision === "approved") {
      await this.ports.execution.enqueue({ proposal, actorId: actor.actorId });
    }

    // 6. best-effort surface update
    if (deliveredRef) {
      try {
        await this.surfaces.get(incoming.surface).updateDecision({
          ref: deliveredRef,
          to: incoming.context?.to ?? "",
          proposal,
          decision: incoming.decision,
          actorLabel,
        });
      } catch {
        // Surface update failure does not invalidate a recorded decision.
      }
    }

    return { status: "applied", decision: incoming.decision, actorLabel };
  }
}
