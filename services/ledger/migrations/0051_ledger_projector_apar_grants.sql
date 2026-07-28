-- Fix-forward production grants for the canonical AP/AR to Ledger projection.
--
-- The AP/AR worker reads canonical_counterparty and canonical_obligation,
-- narrowly repairs stale canonical counterparty links, writes compact
-- ledger_obligations, and mirrors receivable invoice obligations into
-- ledger_invoices. These are projection-table writes only; retained raw bytes
-- and canonical evidence remain untouched.
--
-- infra/db-roles.sql carries the desired grant model for fresh environments,
-- but production can miss grants when that operator script is not re-applied
-- after new projection tables are introduced. This migration self-heals the
-- runtime role on deploy while staying no-op in local databases where the
-- least-privilege role has not been created.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'brain_ledger_projector') THEN
    EXECUTE 'GRANT SELECT ON canonical_counterparty, canonical_obligation TO brain_ledger_projector';
    EXECUTE 'GRANT UPDATE (canonical_counterparty_id, updated_at) ON canonical_obligation TO brain_ledger_projector';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON ledger_invoices TO brain_ledger_projector';
  END IF;
END
$$;

COMMIT;
