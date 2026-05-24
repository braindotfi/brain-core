-- H-22 duplicate-payment detection indexes.
--
-- Supports the §6 gate check 11.5 detector (services/policy/src/duplicate-detector.ts).
-- Column reality vs the hardening spec: the tenant column is `owner_id` (not
-- `tenant_id`), the lifecycle column is `status` (not `state`), and there is no
-- `executed_at` — `updated_at` is the execution time for an executed row.
-- `dispatching` is intentionally omitted from the obligation index until the
-- H-04 outbox migration adds that status to the CHECK constraint.
--
-- RLS is already armed + FORCE-enabled on ledger_payment_intents (migration 0010
-- + 0017 role model); these are plain covering indexes, no policy change.

CREATE INDEX IF NOT EXISTS idx_payment_intents_dedup
  ON ledger_payment_intents (owner_id, destination_counterparty_id, amount, currency, updated_at)
  WHERE status = 'executed';

CREATE INDEX IF NOT EXISTS idx_payment_intents_invoice_executed
  ON ledger_payment_intents (owner_id, invoice_id)
  WHERE invoice_id IS NOT NULL AND status = 'executed';

CREATE INDEX IF NOT EXISTS idx_payment_intents_obligation_active
  ON ledger_payment_intents (owner_id, obligation_id)
  WHERE obligation_id IS NOT NULL AND status IN ('executed', 'approved');
