/**
 * Agent proposal state machine (BRAIN-CORE-ORCHESTRATION-GAP.md §3).
 *
 *   [needs_review] ──approved──> [approved]           (execution_mode=propose only)
 *   [needs_review] ──rejected──> [rejected]            (execution_mode=propose only)
 *   [needs_review] ──acknowledged──> [acknowledged]    (execution_mode=notify_only only)
 *   [approved] ──undone_to_review──> [undone_to_review] (reversible=true only)
 *   [undone_to_review] ──approved──> [approved]
 *   [undone_to_review] ──rejected──> [rejected]
 *
 * Pure function, no I/O. The caller (repository CAS update) is what makes
 * the transition durable; this is the single place the legality of a
 * transition is decided.
 */

import { brainError } from "@brain/shared";

export type AgentProposalStatus =
  | "needs_review"
  | "acknowledged"
  | "approved"
  | "rejected"
  | "undone_to_review";

export type AgentProposalDecision = "approved" | "rejected" | "acknowledged" | "undone_to_review";

export type AgentProposalExecutionMode = "propose" | "notify_only";

/**
 * Compute the next status for an agent proposal, or throw
 * `agent_proposal_invalid_state` if the transition is not legal.
 */
export function nextStatus(
  current: AgentProposalStatus,
  decision: AgentProposalDecision,
  executionMode: AgentProposalExecutionMode,
  reversible: boolean,
): AgentProposalStatus {
  if (current === "needs_review" && decision === "approved" && executionMode === "propose") {
    return "approved";
  }
  if (current === "needs_review" && decision === "rejected" && executionMode === "propose") {
    return "rejected";
  }
  if (
    current === "needs_review" &&
    decision === "acknowledged" &&
    executionMode === "notify_only"
  ) {
    return "acknowledged";
  }
  if (current === "approved" && decision === "undone_to_review" && reversible) {
    return "undone_to_review";
  }
  if (current === "undone_to_review" && decision === "approved") {
    return "approved";
  }
  if (current === "undone_to_review" && decision === "rejected") {
    return "rejected";
  }
  throw brainError(
    "agent_proposal_invalid_state",
    `invalid agent proposal transition ${current} + ${decision}`,
  );
}
