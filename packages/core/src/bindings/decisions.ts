import type { ApprovalDecisionStore, DecisionClaim, TerminalDecisionRecord } from "@brain/surfaces";
import type { DecisionStore } from "../internal/services.js";

/**
 * Binds the terminal-decision idempotency port to brain-core storage.
 * Implementations must claim by tenantId/proposalId atomically so a double click
 * from any surface cannot duplicate audit or execution handoff.
 */
export class CoreApprovalDecisionStore implements ApprovalDecisionStore {
  constructor(private readonly store: DecisionStore) {}

  async claimTerminal(record: TerminalDecisionRecord): Promise<DecisionClaim> {
    return this.store.claimTerminal(record);
  }

  async markTerminalApplied(record: TerminalDecisionRecord): Promise<void> {
    await this.store.markTerminalApplied(record);
  }
}
