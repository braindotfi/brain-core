/**
 * @brain/ledger
 *
 * Layer 2 — Normalized financial truth. Owns 11 entities per
 * Brain_MVP_Architecture.md §3 Layer 2.
 */

export const SERVICE_NAME = "brain-ledger" as const;

export { buildLedgerApp, registerLedgerPlugin, type BuildLedgerAppOptions } from "./server.js";
export { LedgerService } from "./service/LedgerService.js";
export type { LedgerDeps } from "./deps.js";
export * from "./repository/index.js";
// The sanctioned cross-service surface for PaymentIntent ops (services/execution
// uses this, not the raw repository functions — enforced by no-restricted-imports).
export { LedgerPaymentIntents } from "./payment-intents-facade.js";

// Phase 3: extractor + write paths exported so other workers (BullMQ
// extractor jobs, the /wiki/annotate write-through path) can call into
// the Ledger without going through the HTTP boundary.
export {
  recordTransactionRow,
  upsertAccountRow,
  upsertCounterpartyRow,
  normalizeName,
} from "./service/writes.js";
export {
  normalizePlaidArtifact,
  type PlaidAccountPayload,
  type PlaidTransactionPayload,
  type PlaidExtractInput,
  type ExtractedLedgerRow,
} from "./extractors/plaid.js";
export {
  startNormalizeWorker,
  type NormalizeWorker,
  type NormalizeWorkerOptions,
} from "./workers/normalizeWorker.js";

// RFC 0004 §7.1 corroboration write-back: the sanctioned entry point for
// recording a cross-source match and lifting the matched obligation's
// provenance/confidence. Exported for the wedge acceptance test and the
// Phase 4 resolution stage; matchers call it internally.
export {
  persistMatch,
  type PersistMatchInput,
  type PersistMatchResult,
} from "./reconciliation/persist.js";

// Phase 4 resolution: the read-side reconciled view over linked obligation
// observations (field-level authority, conflicts preserved, reversible).
export {
  resolveObligationView,
  type ResolvedObligationView,
  type ObligationObservationView,
  type ObligationConflict,
} from "./resolution/resolveObligation.js";
export {
  resolveCounterpartyView,
  type ResolvedCounterpartyView,
  type CounterpartyObservationView,
} from "./resolution/resolveCounterparty.js";
export {
  resolveAccountView,
  type ResolvedAccountView,
  type AccountObservationView,
} from "./resolution/resolveAccount.js";
export { ReconciliationService } from "./reconciliation/ReconciliationService.js";

// Phase 5 (RFC 0005): the Ledger chart-of-accounts projection of canonical.
export {
  rebuildAccountingProjectionFromCanonical,
  confirmGlAccountName,
  upsertLedgerGlAccount,
  toLedgerGlAccountInput,
  type LedgerGlAccountInput,
  type RebuildResult,
} from "./projection/gl-accounts.js";
export {
  runLedgerProjectionCycle,
  startLedgerProjectionWorker,
  type LedgerProjectionWorker,
  type LedgerProjectionWorkerDeps,
  type LedgerProjectionWorkerOptions,
} from "./projection/worker.js";
// Phase 5 deep refactor: the Ledger AP/AR projection of canonical.
export {
  rebuildAparProjectionFromCanonical,
  runLedgerAparProjectionCycle,
  startLedgerAparProjectionWorker,
  type AparRebuildResult,
  type LedgerAparProjectionWorker,
  type LedgerAparProjectionWorkerDeps,
  type LedgerAparProjectionWorkerOptions,
} from "./projection/obligations.js";
