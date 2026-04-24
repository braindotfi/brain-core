/**
 * Type-safe registry of Wiki entity and relation kinds.
 *
 * MVP per Brain_MVP_Architecture.md §3 Layer 2:
 *   Entity kinds:   account, counterparty, transaction, obligation, policy, agent
 *   Relation kinds: transacted_with, owes, owed_by, governed_by
 *   Provenance:     extracted, inferred, ambiguous, human_confirmed, agent_contributed
 */

export const ENTITY_KINDS = [
  "account",
  "counterparty",
  "transaction",
  "obligation",
  "policy",
  "agent",
] as const;

export const RELATION_KINDS = [
  "transacted_with",
  "owes",
  "owed_by",
  "governed_by",
] as const;

export const PROVENANCE_VALUES = [
  "extracted",
  "inferred",
  "ambiguous",
  "human_confirmed",
  "agent_contributed",
] as const;

export type EntityKind = (typeof ENTITY_KINDS)[number];
export type RelationKind = (typeof RELATION_KINDS)[number];
export type Provenance = (typeof PROVENANCE_VALUES)[number];

/**
 * §3 Layer 2 + §3.2: agent-contributed entities start at a confidence
 * ceiling of 0.5. Promotion above requires independent corroboration or
 * explicit tenant approval via /wiki/annotate.
 */
export const AGENT_CONTRIBUTED_CONFIDENCE_CEILING = 0.5;
