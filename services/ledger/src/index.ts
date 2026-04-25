/**
 * @brain/ledger
 *
 * Layer 2 — Normalized financial truth. Owns 11 entities per
 * Brain_MVP_Architecture.md §3 Layer 2.
 */

export const SERVICE_NAME = "brain-ledger" as const;

export { buildLedgerApp, type BuildLedgerAppOptions } from "./server.js";
export { LedgerService } from "./service/LedgerService.js";
export type { LedgerDeps } from "./deps.js";
export * from "./repository/index.js";

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
