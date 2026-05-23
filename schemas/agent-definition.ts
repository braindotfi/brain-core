/**
 * Internal Agent Definition — the design-time descriptor for a Brain-shipped
 * (internal) or external agent. See agent-definition.schema.json for the
 * canonical JSON Schema and field docs.
 *
 * `provenance` maps 1:1 to AgentRecord.kind ("internal" | "external") in
 * services/execution. This descriptor is additive on the agent registration
 * shape — it does NOT introduce a parallel agent abstraction.
 */

export const AGENT_PROVENANCE = ["internal", "external"] as const;
export const AGENT_CATEGORIES = ["business", "consumer", "agnostic"] as const;
export const AGENT_RISK_LEVELS = ["low", "medium", "high"] as const;
export const AGENT_AUTHORITIES = ["execute", "propose", "notify_only"] as const;

export type AgentProvenance = (typeof AGENT_PROVENANCE)[number];
export type AgentCategory = (typeof AGENT_CATEGORIES)[number];
export type AgentRiskLevel = (typeof AGENT_RISK_LEVELS)[number];
export type AgentAuthority = (typeof AGENT_AUTHORITIES)[number];

/**
 * Weighted required-evidence spec (Agent Autonomy v3, 1a.4). A bare `kind`
 * string is shorthand for `{ kind, weight: 1/N, required: true }` where N is
 * the number of declared entries — see normalizeRequiredEvidence in
 * @brain/internal-agents. Weights across a definition normally sum to ~1.
 */
export interface RequiredEvidenceSpec {
  readonly kind: string;
  /** Contribution to the weighted evidence_score, 0..1. */
  readonly weight: number;
  /** When true, a missing item flags critical_missing and forces notify_only/reject. */
  readonly required: boolean;
  /** Max age before an item counts as stale (e.g. "30d", "24h", "1h"). */
  readonly max_age?: string;
}

/** A required-evidence entry: a bare kind string (legacy) or a weighted spec. */
export type RequiredEvidence = string | RequiredEvidenceSpec;

/** Maps a set of intent patterns to the action they should resolve to (1a.1). */
export interface IntentActionRule {
  readonly patterns: readonly string[];
  readonly action: string;
}

export interface InternalAgentDefinition {
  /** Stable identifier, e.g. "collections". */
  readonly agent_key: string;
  readonly display_name?: string;
  /** "internal" = Brain-shipped; "external" = third-party. Maps to AgentRecord.kind. */
  readonly provenance: AgentProvenance;
  readonly category: AgentCategory;
  /** Capability identifiers; keccak256(name) is the on-chain capability hash. */
  readonly capabilities: readonly string[];
  readonly mcp_endpoint?: string;
  readonly metadata_uri?: string;
  /** Domain-event names that activate this agent, e.g. "invoice.overdue". */
  readonly triggers: readonly string[];
  /** Natural-language intent patterns the rules-based classifier matches. */
  readonly intent_patterns: readonly string[];
  /** Ledger/Wiki data classes the agent is allowed to read. */
  readonly readable_data: readonly string[];
  readonly risk_level: AgentRiskLevel;
  /** Below this confidence the router/agent returns notify_only. */
  readonly minimum_confidence: number;
  /**
   * Required evidence. Each entry is a bare kind string (weight 1/N, required)
   * or a weighted {@link RequiredEvidenceSpec}. Missing required evidence forces
   * notify_only/reject; weights feed the evidence_score (1a.4).
   */
  readonly required_evidence: readonly RequiredEvidence[];
  readonly default_authority: AgentAuthority;
  readonly enabled_by_default: boolean;

  // --- Action resolution (Agent Autonomy v3, 1a.1) ---
  // The ActionResolver picks the action within a selected agent in this order:
  // explicit requested action → event_action_map → intent_action_map →
  // default_action. If none resolves it returns missing_action; it NEVER
  // silently falls back to handler.actions[0].

  /** Domain-event name → action id. */
  readonly event_action_map?: Readonly<Record<string, string>>;
  /** Intent-pattern groups → action id, scored via the configured classifier. */
  readonly intent_action_map?: readonly IntentActionRule[];
  /**
   * Opt-in last-resort action when nothing else resolves. Omitted for
   * money-mover and high-risk agents so an unmatched event surfaces as
   * missing_action rather than silently selecting a financial action.
   */
  readonly default_action?: string;
}
