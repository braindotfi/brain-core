/**
 * @brain/canonical
 *
 * The canonical domain layer (ingestion architecture §12). Rich, versioned
 * domain records that the Ledger and Wiki surfaces project from. Sits between
 * Raw (layer 1) and Ledger (layer 2): downstream of Raw evidence, upstream of
 * the compact Ledger projection. Never reads Wiki or Policy.
 *
 * Phase 5 instantiates only the accounting domain (GL accounts, journal
 * entries, journal lines) — the data the Merge aggregator already lands
 * unprojected in raw_parsed. Other §12 domains are deferred until a paying
 * use case demands the structure.
 */

export const SERVICE_NAME = "brain-canonical" as const;

export {
  CANONICAL_DOMAINS,
  type CanonicalDomain,
  type CanonicalProvenance,
  type AccountClassification,
  type LineDirection,
  type CanonicalGlAccount,
  type CanonicalJournalEntry,
  type CanonicalJournalLine,
} from "./accounting/types.js";

export { classifyAccount } from "./accounting/classify.js";
export {
  toScaled,
  fromScaled,
  totalsByDirection,
  netImbalance,
  isBalanced,
  type DirectionalAmount,
} from "./accounting/balance.js";
