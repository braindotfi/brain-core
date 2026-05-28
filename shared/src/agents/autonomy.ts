/**
 * Autonomy modes — the four-rung safety ladder exposed to operators and
 * external consumers (post-review item 7).
 *
 * The codebase already had three orthogonal axes that together define how
 * "autonomous" an agent is for a given action:
 *   - LIVE_AGENTS shadow gate (per-tenant promotion): shadow vs live
 *   - default_authority (per-agent definition): execute / propose / notify_only
 *   - policy outcome (per-decision): allow / confirm / reject
 *
 * Operators, customers, and investors don't think in those three axes. This
 * module collapses them into one observable label so the same vocabulary the
 * pitch deck uses ("shadow", "recommend", "confirm", "live") lines up with a
 * single derived value at runtime.
 *
 *   shadow    — promotion not granted, OR `notify_only` authority. The agent
 *               observes + records but never produces a money-touching proposal.
 *   recommend — the agent produces a proposal as evidence/insight only; the
 *               PaymentIntent is created in a non-executing state regardless
 *               of policy outcome (operator-decided).
 *   confirm   — the agent produces a proposal; policy resolves to `confirm`
 *               (or the agent's risk_level mandates approval). A signed
 *               human/approver decision is required before the §6 gate
 *               permits execution.
 *   live      — the agent produces a proposal; policy resolves to `allow` and
 *               LIVE_AGENTS grants execution. The §6 gate decides at runtime;
 *               money may move.
 *
 * `live` is the only mode that can move money WITHOUT a human approval in the
 * loop. Even `live` is still §6-gated — the four modes do not bypass any
 * deterministic check; they describe *what an operator should expect* under
 * normal policy flow.
 */

export type AutonomyMode = "shadow" | "recommend" | "confirm" | "live";

export const AUTONOMY_MODES: ReadonlyArray<AutonomyMode> = [
  "shadow",
  "recommend",
  "confirm",
  "live",
];

/** Inputs to {@link deriveAutonomyMode}. The three orthogonal axes the codebase
 *  already encodes; this helper folds them into one displayable label. */
export interface DeriveAutonomyModeInput {
  /**
   * Per-tenant promotion state from LIVE_AGENTS. False ⇒ the agent is in
   * shadow for this tenant regardless of authority/policy.
   */
  readonly isLive: boolean;
  /**
   * The agent's static authority ceiling (default_authority on
   * InternalAgentDefinition). `notify_only` cannot produce a proposal at all
   * ⇒ shadow. `propose` produces a proposal but never auto-executes
   * ⇒ recommend. `execute` defers to the policy outcome.
   */
  readonly defaultAuthority: "execute" | "propose" | "notify_only";
  /**
   * The MAX policy outcome the matched rule allows (Policy VM resolves this
   * per decision; for static rendering, callers pass the rule's ceiling).
   * `confirm` means human-in-the-loop is mandatory; `allow` means policy
   * permits unattended execution if everything else lines up.
   */
  readonly policyMaxOutcome: "allow" | "confirm" | "reject";
}

/**
 * Collapse the three axes into one mode.
 *
 * Truth table (in priority order — the first matching row wins):
 *
 *   isLive=false                              ⇒ shadow
 *   defaultAuthority=notify_only              ⇒ shadow
 *   defaultAuthority=propose                  ⇒ recommend
 *   policyMaxOutcome=reject                   ⇒ shadow  (no path to action)
 *   policyMaxOutcome=confirm                  ⇒ confirm
 *   policyMaxOutcome=allow + authority=execute⇒ live
 *
 * The function is deterministic and total — every input combination resolves
 * to exactly one mode. Document the truth table in CLAUDE.md when this lands
 * so the four modes have one canonical reference.
 */
export function deriveAutonomyMode(input: DeriveAutonomyModeInput): AutonomyMode {
  if (!input.isLive) return "shadow";
  if (input.defaultAuthority === "notify_only") return "shadow";
  if (input.defaultAuthority === "propose") return "recommend";
  // defaultAuthority is now "execute" — policy outcome decides.
  if (input.policyMaxOutcome === "reject") return "shadow";
  if (input.policyMaxOutcome === "confirm") return "confirm";
  return "live";
}
