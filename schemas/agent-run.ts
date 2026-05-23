/**
 * Agent-run status vocabulary (Agent Autonomy v3, 1a.3).
 *
 * The single source of truth for agent_runs.status. Handler/worker/route code
 * must use a value from this set — do NOT invent new statuses inline.
 *
 * Lives in @brain/schemas (a leaf package) so both @brain/agent-router (the
 * worker that produces statuses) and @brain/execution (which persists them)
 * reference the same list without a workspace cycle.
 */

export const AGENT_RUN_STATUSES = [
  "routing",
  "routed",
  "no_match",
  "unscoped",
  "missing_handler",
  "missing_action",
  "missing_evidence",
  "proposal_created",
  "confirmation_required",
  "executed",
  "notify_only",
  "rejected",
  "failed",
  "duplicate_skipped",
  "paused",
  "shadow_completed",
] as const;

export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

/** Policy outcome recorded on a run (gate/dry-run), plus "unknown" pre-evaluation. */
export const AGENT_POLICY_STATUSES = ["allow", "confirm", "reject", "unknown"] as const;
export type AgentPolicyStatus = (typeof AGENT_POLICY_STATUSES)[number];
