-- Backfill canonical refs onto existing document-extracted obligations
-- (Phase 5, doc-obligation canonical home, RFC 0005).
--
-- Before the cutover the doc_obligation extractor wrote ledger_obligations
-- directly. They now project from canonical_obligation (source_system
-- 'document', source_natural_key = the document's raw_artifact_id). This links
-- the pre-existing Ledger rows to their canonical record so the projection
-- upserts in place rather than duplicating.
--
-- Obligations only: a document obligation's source_ids carry its raw_artifact_id,
-- which is exactly the canonical_obligation's source_natural_key, so the match
-- is precise and document-scoped. Counterparties are intentionally NOT
-- backfilled: a document counterparty's natural key is its normalized name,
-- which could collide with a non-document row of the same name -- the projection
-- creates canonical-keyed counterparties going forward and Phase-4 resolution
-- links the legacy rows (link, don't merge). Forward-only; fills NULLs only.

BEGIN;

UPDATE ledger_obligations lo
   SET canonical_obligation_id = co.id
  FROM canonical_obligation co
 WHERE co.tenant_id = lo.owner_id
   AND co.source_system = 'document'
   AND co.source_natural_key = ANY(lo.source_ids)
   AND lo.canonical_obligation_id IS NULL;

COMMIT;
