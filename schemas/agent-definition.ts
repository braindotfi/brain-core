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
  /** Evidence kinds that must be present; missing forces notify_only. */
  readonly required_evidence: readonly string[];
  readonly default_authority: AgentAuthority;
  readonly enabled_by_default: boolean;
}
