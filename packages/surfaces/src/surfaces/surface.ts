import type { Proposal } from "../proposal/schema.js";
import type { SurfaceName } from "../core/ports.js";
import type { DeliveryResult } from "../core/types.js";

/**
 * Every surface implements this. The dispatcher knows nothing about Block Kit,
 * Adaptive Cards, or email HTML. It only knows deliver() and updateDecision().
 */
export interface SurfaceAdapter {
  readonly name: SurfaceName;

  /** Render the proposal natively and deliver it to the target. */
  deliver(proposal: Proposal, to: string): Promise<DeliveryResult>;

  /**
   * Update an already-delivered message to reflect a terminal decision, for
   * example swap the buttons for an "Approved by X" banner. Best-effort.
   */
  updateDecision(input: {
    ref: string;
    to: string;
    proposal: Proposal;
    decision: "approved" | "rejected" | "expired";
    actorLabel: string;
  }): Promise<void>;
}
