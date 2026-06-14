/**
 * Canonical accounting domain types (ingestion architecture §12, Phase 5).
 *
 * These mirror the canonical_* tables in migrations/0001. Shared, queryable
 * fields are typed columns; provider-only fields live in `extensions` and are
 * never flattened into the shared shape.
 */

/** Provenance vocabulary shared with the Ledger trust model (Phase 2). */
export type CanonicalProvenance =
  | "extracted"
  | "agent_contributed"
  | "customer_asserted"
  | "human_confirmed";

/** Normalized chart-of-accounts classification. */
export type AccountClassification =
  | "asset"
  | "liability"
  | "equity"
  | "revenue"
  | "expense"
  | "unknown";

/** Double-entry leg direction. */
export type LineDirection = "debit" | "credit";

/** The domains this layer instantiates now (§12: only what Brain monetizes). */
export const CANONICAL_DOMAINS = ["accounting"] as const;
export type CanonicalDomain = (typeof CANONICAL_DOMAINS)[number];

export interface CanonicalGlAccount {
  id: string;
  tenant_id: string;
  schema_version: number;
  source_system: string;
  source_natural_key: string;
  name: string;
  classification: AccountClassification;
  account_number: string | null;
  currency: string | null;
  status: string | null;
  provenance: CanonicalProvenance;
  confidence: number | null;
  source_ids: string[];
  evidence_ids: string[];
  extensions: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface CanonicalJournalEntry {
  id: string;
  tenant_id: string;
  schema_version: number;
  source_system: string;
  source_natural_key: string;
  posted_at: Date | null;
  memo: string | null;
  currency: string | null;
  status: string | null;
  provenance: CanonicalProvenance;
  confidence: number | null;
  source_ids: string[];
  evidence_ids: string[];
  extensions: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface CanonicalJournalLine {
  id: string;
  tenant_id: string;
  journal_entry_id: string;
  line_number: number;
  gl_account_id: string | null;
  gl_account_key: string | null;
  direction: LineDirection;
  amount: string;
  currency: string | null;
  description: string | null;
  extensions: Record<string, unknown>;
  created_at: Date;
}
