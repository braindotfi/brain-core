/**
 * Merge accounting extractor — `merge_accounting_v1` raw_parsed rows.
 *
 * As of the Phase 5 cutover (RFC 0005, deep refactor PR-G) this is a validated
 * NO-OP: Merge accounting data no longer writes the Ledger directly. It flows
 *
 *   Raw (merge_accounting_v1 pages)
 *     -> canonical projector (services/canonical) -> canonical_* records
 *       -> Ledger projection (services/ledger/src/projection) -> ledger_* rows
 *
 * so obligations, counterparties, GL accounts, and journal entries are all
 * projections of the rich canonical domain rather than flattened on ingest.
 * Identity is canonical-source-keyed and linked by Phase-4 resolution (link,
 * don't merge), not collapsed by creation-time name dedup as it was here.
 *
 * The parser stays REGISTERED (returning no rows) so LedgerService.normalize
 * still records the raw_parsed row as consumed in normalization_log; the
 * canonical projector consumes the same rows independently via
 * canonical_projection_log. Other connectors (Stripe, Finch, Plaid,
 * doc_obligation) are unaffected and still write the Ledger directly.
 */

import type { Pool } from "pg";
import { brainError, type AuditEmitter, type ServiceCallContext } from "@brain/shared";
import type { ExtractedRow, ParserExtractInput } from "./registry.js";

export async function normalizeMergeAccountingArtifact(
  _pool: Pool,
  _audit: AuditEmitter,
  _ctx: ServiceCallContext,
  input: ParserExtractInput,
): Promise<ExtractedRow[]> {
  const objectType = input.payload["object_type"];
  const objects = input.payload["objects"];
  if (typeof objectType !== "string" || !Array.isArray(objects)) {
    throw brainError(
      "ledger_row_invalid",
      "merge_accounting_v1: payload must carry object_type + objects",
    );
  }
  // Intentionally no Ledger writes: the canonical projection owns these records
  // now (see file header). Returning [] marks the row consumed without flattening.
  return [];
}
