/**
 * Repository row shapes.
 *
 * pg returns NUMERIC as string by default — we keep them as strings end-
 * to-end to avoid f64 precision loss. The contract types in
 * @brain/api/shared/contracts use the same convention (DecimalString).
 */

export interface LedgerRowCommon {
  id: string;
  owner_id: string;
  source_ids: string[];
  evidence_ids: string[];
  provenance: string;
  confidence: number;
  created_at: Date;
  updated_at: Date;
}

/** Row counts on the most-recent INSERT/UPDATE. Useful for idempotency tests. */
export interface WriteOutcome<T> {
  row: T;
  inserted: boolean;
  updated: boolean;
}
