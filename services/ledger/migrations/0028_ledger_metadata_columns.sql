-- Brain Ledger — extensible per-entity metadata.
--
-- Adds a tenant-scoped, off-chain `metadata` JSONB to counterparties and
-- invoices. This holds structured context that has no dedicated column but
-- belongs to the financial entity (v0.3: financial truth lives in the Ledger,
-- not Wiki). First consumer: the BrainSaaS Playground demo, which stores a
-- vendor's monthly approval ceiling, a customer's relationship enrichment, and
-- an AP invoice's document-analysis flags / PO here, read back by counterparty
-- / invoice id with no indirection.
--
-- Additive and nullable-by-default; existing rows get '{}'. RLS already governs
-- both tables (the new column inherits row-level isolation).

BEGIN;

ALTER TABLE ledger_counterparties
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE ledger_invoices
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMIT;
