/**
 * State machines §8.1 (proposal), §8.2 (execution), §8.4 (agent registration).
 * Every transition must pass the canonical guard — the only way a row's
 * state changes is via these helpers.
 */

import { brainError } from "@brain/shared";

// ---------------------------------------------------------------------------
// §8.1 Proposal
// ---------------------------------------------------------------------------

export type ProposalState =
  | "pending"
  | "approved"
  | "acknowledged"
  | "reconciling"
  | "rejected"
  | "executed"
  | "failed"
  | "undone"
  | "unknown";

export function isValidProposalTransition(from: ProposalState, to: ProposalState): boolean {
  switch (from) {
    case "pending":
      return to === "approved" || to === "rejected" || to === "acknowledged";
    case "approved":
      return to === "executed" || to === "rejected" || to === "undone" || to === "reconciling";
    case "reconciling":
      return to === "executed" || to === "failed";
    case "executed":
      return to === "failed"; // allows reversion path to new proposal
    case "acknowledged":
    case "rejected":
    case "failed":
    case "undone":
    case "unknown":
      return false;
  }
}

export function assertProposalTransition(from: ProposalState, to: ProposalState): void {
  if (!isValidProposalTransition(from, to)) {
    throw brainError(
      "execution_proposal_invalid_state",
      `invalid proposal transition ${from} → ${to}`,
    );
  }
}

// ---------------------------------------------------------------------------
// §8.2 Execution
// ---------------------------------------------------------------------------

export type ExecutionState = "dispatched" | "in_flight" | "completed" | "failed";

export function isValidExecutionTransition(from: ExecutionState, to: ExecutionState): boolean {
  switch (from) {
    case "dispatched":
      return to === "in_flight" || to === "failed";
    case "in_flight":
      return to === "completed" || to === "failed";
    case "completed":
    case "failed":
      return false;
  }
}

export function assertExecutionTransition(from: ExecutionState, to: ExecutionState): void {
  if (!isValidExecutionTransition(from, to)) {
    throw brainError(
      "execution_proposal_invalid_state",
      `invalid execution transition ${from} → ${to}`,
    );
  }
}

// ---------------------------------------------------------------------------
// §8.4 Agent registration
// ---------------------------------------------------------------------------

export type AgentState = "pending_onchain" | "active" | "revoked" | "failed" | "quarantined";

export function isValidAgentTransition(from: AgentState, to: AgentState): boolean {
  switch (from) {
    case "pending_onchain":
      return to === "active" || to === "failed";
    case "active":
      // Kill-switch (1b.3): /halt quarantines an active agent.
      return to === "revoked" || to === "quarantined";
    case "quarantined":
      // Recoverable: lift the quarantine back to active, or revoke permanently.
      return to === "active" || to === "revoked";
    case "revoked":
    case "failed":
      return false;
  }
}

export function assertAgentTransition(from: AgentState, to: AgentState): void {
  if (!isValidAgentTransition(from, to)) {
    throw brainError("execution_agent_not_registered", `invalid agent transition ${from} → ${to}`);
  }
}
