/**
 * Type-safe registry of Brain kinds.
 *
 * v0.3 split: financial truth lives in the Ledger (Layer 2); Wiki
 * (Layer 3) keeps only pointer types.
 *
 *   LEDGER_KINDS — schemas under schemas/entity/ that validate Ledger row
 *                  attributes (account, counterparty, transaction,
 *                  obligation). Used by the extractor pipeline.
 *   WIKI_KINDS   — kinds still stored in wiki_entities after migration
 *                  0003 narrows the CHECK to {policy, agent}. These are
 *                  pointer types whose canonical record lives in another
 *                  service.
 *   ENTITY_KINDS — backward-compat alias = LEDGER_KINDS ∪ WIKI_KINDS.
 *                  Existing call sites that load schemas (e.g. the AJV
 *                  registry in services/wiki) keep working.
 *   RELATION_KINDS — Wiki relation kinds. Deprecated post-Phase 3 but
 *                  retained for the v0.3 transition; see schemas/README.md
 *                  for the v0.3 mapping table from these to Ledger
 *                  queries.
 */

export const LEDGER_KINDS = ["account", "counterparty", "transaction", "obligation"] as const;

export const WIKI_KINDS = ["policy", "agent"] as const;

export const ENTITY_KINDS = [...LEDGER_KINDS, ...WIKI_KINDS] as const;

export const RELATION_KINDS = ["transacted_with", "owes", "owed_by", "governed_by"] as const;

export const PROVENANCE_VALUES = [
  "extracted",
  "inferred",
  "ambiguous",
  "human_confirmed",
  "agent_contributed",
] as const;

export type LedgerKind = (typeof LEDGER_KINDS)[number];
export type WikiKind = (typeof WIKI_KINDS)[number];
export type EntityKind = (typeof ENTITY_KINDS)[number];
export type RelationKind = (typeof RELATION_KINDS)[number];
export type Provenance = (typeof PROVENANCE_VALUES)[number];

/**
 * §3 Layer 2 + §3.2: agent-contributed Ledger rows are capped at 0.5.
 * Enforced in services/ledger/src/service/writes.ts.
 */
export const AGENT_CONTRIBUTED_CONFIDENCE_CEILING = 0.5;

// Internal Agent Definition descriptor (router + registration consume this).
export * from "./agent-definition.js";
// Agent-run status vocabulary (run persistence + worker statuses).
export * from "./agent-run.js";
