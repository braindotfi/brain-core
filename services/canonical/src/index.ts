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

export {
  MERGE_ACCOUNTING_PROJECTOR,
  MERGE_ACCOUNTING_PARSER,
  PROJECTABLE_OBJECT_TYPES,
  projectGlAccount,
  projectJournalEntry,
  splitSignedAmount,
  toPlainDecimal,
  type ProjectableObjectType,
  type ProjectionCommon,
  type GlAccountUpsert,
  type JournalEntryUpsert,
  type JournalLineUpsert,
} from "./projectors/merge-accounting.js";

export { upsertGlAccount, upsertJournalEntry, type UpsertResult } from "./repository/accounting.js";

export {
  projectMergeContact,
  projectMergeInvoice,
  normalizeName,
  type CounterpartyType,
  type ObligationDirection,
  type CounterpartyUpsert,
  type ObligationUpsert,
} from "./projectors/merge-apar.js";

export { upsertCanonicalCounterparty, upsertCanonicalObligation } from "./repository/apar.js";

export {
  projectDocObligation,
  DOCUMENT_SOURCE_SYSTEM,
  type DocProjection,
} from "./projectors/doc-obligation.js";

// Phase 6 governed read API.
export { registerCanonicalRoutes } from "./routes.js";
export type { CanonicalDeps } from "./deps.js";
export {
  getObligationProduct,
  listObligationProducts,
  toObligationProduct,
  type ObligationProduct,
} from "./query/obligations.js";
export {
  getGlAccountProduct,
  listGlAccountProducts,
  toGlAccountProduct,
  type GlAccountProduct,
} from "./query/gl-accounts.js";
export {
  getJournalEntryProduct,
  listJournalEntryProducts,
  toJournalEntryProduct,
  type JournalEntryProduct,
  type JournalLineView,
} from "./query/journal-entries.js";

export {
  runProjectionCycle,
  startCanonicalProjectionWorker,
  type ProjectionWorker,
  type ProjectionWorkerDeps,
  type ProjectionWorkerOptions,
} from "./projectors/worker.js";
