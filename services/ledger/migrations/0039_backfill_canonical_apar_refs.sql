-- Backfill canonical AP/AR refs onto existing Merge-written Ledger rows
-- (Phase 5 cutover, RFC 0005, PR-G).
--
-- Before the cutover the merge_accounting extractor wrote ledger_obligations /
-- ledger_counterparties directly, stamping the Merge id into metadata.merge
-- (invoice_id / contact_id). After the cutover those rows are a projection of
-- canonical, keyed on canonical_obligation_id / canonical_counterparty_id. This
-- backfill links the pre-existing rows to their canonical record so the
-- projection upserts IN PLACE rather than creating duplicates.
--
-- The match is at most 1:1: the Merge id is unique per (tenant, source_system)
-- in canonical, and the old extractor produced at most one Ledger row per Merge
-- id (its content dedup key never split one id across rows). Rows that do not
-- match (e.g. invoice-embedded placeholder counterparties keyed by name, or
-- non-Merge rows) keep a NULL canonical ref and remain legacy content-keyed
-- observations -- Phase-4 resolution links them, nothing is lost.
--
-- Forward-only and idempotent: only fills NULLs, only where the Merge id is set.

BEGIN;

UPDATE ledger_counterparties lc
   SET canonical_counterparty_id = cc.id
  FROM canonical_counterparty cc
 WHERE cc.tenant_id = lc.owner_id
   AND cc.source_natural_key = lc.metadata->'merge'->>'contact_id'
   AND lc.canonical_counterparty_id IS NULL
   AND lc.metadata->'merge'->>'contact_id' IS NOT NULL;

UPDATE ledger_obligations lo
   SET canonical_obligation_id = co.id
  FROM canonical_obligation co
 WHERE co.tenant_id = lo.owner_id
   AND co.source_natural_key = lo.metadata->'merge'->>'invoice_id'
   AND lo.canonical_obligation_id IS NULL
   AND lo.metadata->'merge'->>'invoice_id' IS NOT NULL;

COMMIT;
