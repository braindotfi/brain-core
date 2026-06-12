-- Brain Ledger -- account entity resolution + provenance CHECK completion.
--
-- 1. Account resolution (Phase 4 §13): the same money pool observed by
--    several sources links via account entity sides on the match table,
--    match_type account_duplicate. Account links are ALWAYS candidates
--    (duplicate_possible) -- "do not silently merge on a weak match" applies
--    doubly to money pools; a human confirms via setStatus.
--
-- 2. Phase 2 completion: customer_asserted joined the Provenance union and
--    the TS writers in the trust-contract PR, but the eight per-table
--    provenance CHECKs (migrations 0002..0010) were never widened -- a live
--    customer_asserted write would have violated them. No connector writes
--    that value yet (the document tier deliberately stays agent_contributed),
--    so this is a latent, not active, break. Widened here, additively.

BEGIN;

ALTER TABLE ledger_reconciliation_matches DROP CONSTRAINT IF EXISTS ledger_reconciliation_matches_match_type_check;
ALTER TABLE ledger_reconciliation_matches
  ADD CONSTRAINT ledger_reconciliation_matches_match_type_check
  CHECK (match_type IN (
    'transaction_receipt','invoice_payment','statement_balance',
    'wallet_transfer','payroll_bank_debit','subscription_charge',
    'card_charge','onchain_settlement','obligation_duplicate',
    'counterparty_duplicate','account_duplicate'
  ));

ALTER TABLE ledger_reconciliation_matches DROP CONSTRAINT IF EXISTS ledger_reconciliation_matches_left_entity_type_check;
ALTER TABLE ledger_reconciliation_matches
  ADD CONSTRAINT ledger_reconciliation_matches_left_entity_type_check
  CHECK (left_entity_type IN (
    'transaction','invoice','obligation','document','balance','transfer','counterparty','account'
  ));

ALTER TABLE ledger_reconciliation_matches DROP CONSTRAINT IF EXISTS ledger_reconciliation_matches_right_entity_type_check;
ALTER TABLE ledger_reconciliation_matches
  ADD CONSTRAINT ledger_reconciliation_matches_right_entity_type_check
  CHECK (right_entity_type IN (
    'transaction','invoice','obligation','document','balance','transfer','counterparty','account'
  ));

-- Provenance CHECK widening across every Layer-2 table that pins it.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'ledger_counterparties','ledger_accounts','ledger_balances',
    'ledger_documents','ledger_transactions','ledger_obligations',
    'ledger_invoices','ledger_payment_intents'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', t, t || '_provenance_check');
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK (provenance IN '
      || '(''extracted'',''inferred'',''ambiguous'',''human_confirmed'',''agent_contributed'',''customer_asserted''))',
      t, t || '_provenance_check'
    );
  END LOOP;
END $$;

COMMIT;
