-- Brain Ledger -- admit 'employee' as a counterparty type.
--
-- Phase 3 Finch connector: payroll lands employees as counterparties (the
-- party a pay run pays). 'employer' exists for the inverse relation; forcing
-- employees into 'other' would destroy source meaning (ingestion
-- architecture §12). Additive CHECK widening; existing rows untouched.

BEGIN;

ALTER TABLE ledger_counterparties DROP CONSTRAINT IF EXISTS ledger_counterparties_type_check;
ALTER TABLE ledger_counterparties
  ADD CONSTRAINT ledger_counterparties_type_check
  CHECK (type IN (
    'merchant','vendor','customer','employer','employee','bank',
    'wallet','exchange','tax_authority','agent','other'
  ));

COMMIT;
