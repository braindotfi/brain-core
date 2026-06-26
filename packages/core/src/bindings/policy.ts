import type { PolicyGate, PolicyVerdict, ResolvedActor, Proposal } from "@brain/surfaces";
import type { PolicyEngine } from "../internal/services.js";

/**
 * Binds the surface PolicyGate port to brain-core's policy engine. This runs at
 * decision time, on the click, so the surface can never become a bypass path.
 * It delegates entirely. It does not encode any gate logic of its own.
 */
export class CorePolicyGate implements PolicyGate {
  constructor(private readonly engine: PolicyEngine) {}

  async canDecide(input: {
    proposal: Proposal;
    actor: ResolvedActor;
    decision: "approved" | "rejected";
  }): Promise<PolicyVerdict> {
    const result = await this.engine.evaluateDecision(input);
    return {
      allowed: result.allowed,
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
      ...(result.awaitingSecondApproval !== undefined
        ? { awaitingSecondApproval: result.awaitingSecondApproval }
        : {}),
    };
  }
}
