-- Brain Ledger -- namespaced extensions on obligations.
--
-- Phase 3 Merge connector (ingestion architecture §12): provider-only fields
-- stay in namespaced extensions, not in shared schemas. The accounting
-- aggregator's bills carry GL coding, remote (original-source) ids, and line
-- structure that the compact obligation row cannot hold; the AC requires GL
-- coding preserved in extensions. Mirrors ledger/0028 (counterparties +
-- invoices). Additive; RLS inherited from the table.

BEGIN;

ALTER TABLE ledger_obligations
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMIT;
