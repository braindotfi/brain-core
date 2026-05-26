-- P0.5: default AP (accounts-payable) account for the invoice shortcut.
--
-- When the invoice shortcut ({ type: "pay_invoice", invoice_id }) runs and the
-- tenant has more than one AP bank account, the resolver uses this configured
-- default to pick the source account. A single AP account needs no default; no
-- AP account and no default fails closed with
-- invoice_shortcut_source_account_unresolved.

BEGIN;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS default_ap_account_id TEXT;

COMMENT ON COLUMN tenants.default_ap_account_id IS
  'Source account for the pay_invoice shortcut when the tenant has multiple AP accounts.';

COMMIT;
