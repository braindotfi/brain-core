-- Apply FORCE ROW LEVEL SECURITY to every tenant-scoped Ledger table.
--
-- Without this, Postgres silently bypasses the RLS policies when the
-- connection role is the table owner (the default in dev and before
-- infra/db-roles.sql is applied in production). FORCE ROW LEVEL SECURITY
-- makes the policies apply unconditionally regardless of role.
--
-- This migration is idempotent: ALTER TABLE ... FORCE ROW LEVEL SECURITY
-- is a no-op if already set.

BEGIN;

ALTER TABLE ledger_accounts               FORCE ROW LEVEL SECURITY;
ALTER TABLE ledger_balances               FORCE ROW LEVEL SECURITY;
ALTER TABLE ledger_categories             FORCE ROW LEVEL SECURITY;
ALTER TABLE ledger_counterparties         FORCE ROW LEVEL SECURITY;
ALTER TABLE ledger_documents              FORCE ROW LEVEL SECURITY;
ALTER TABLE ledger_invoices               FORCE ROW LEVEL SECURITY;
ALTER TABLE ledger_obligations            FORCE ROW LEVEL SECURITY;
ALTER TABLE ledger_payment_intents        FORCE ROW LEVEL SECURITY;
ALTER TABLE ledger_reconciliation_matches FORCE ROW LEVEL SECURITY;
ALTER TABLE ledger_reservations           FORCE ROW LEVEL SECURITY;
ALTER TABLE ledger_transactions           FORCE ROW LEVEL SECURITY;
ALTER TABLE ledger_transfers              FORCE ROW LEVEL SECURITY;
ALTER TABLE normalization_log             FORCE ROW LEVEL SECURITY;

COMMIT;
