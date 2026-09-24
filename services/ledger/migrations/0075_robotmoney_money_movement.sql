BEGIN;

ALTER TABLE ledger_counterparties
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','archived'));

ALTER TABLE ledger_counterparties
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_ledger_counterparties_owner_status
  ON ledger_counterparties (owner_id, status)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS ledger_deposit_instructions (
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES ledger_accounts(id) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK (method IN ('wire','ach','onchain')),
  bank_name TEXT,
  routing_number TEXT,
  account_number TEXT,
  memo_reference TEXT NOT NULL,
  onchain_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, account_id, method),
  CHECK (
    (method IN ('wire','ach') AND routing_number IS NOT NULL AND account_number IS NOT NULL)
    OR (method = 'onchain' AND onchain_address IS NOT NULL)
  )
);

ALTER TABLE ledger_deposit_instructions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_deposit_instructions FORCE ROW LEVEL SECURITY;

CREATE POLICY ledger_deposit_instructions_tenant_read ON ledger_deposit_instructions
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY ledger_deposit_instructions_tenant_insert ON ledger_deposit_instructions
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY ledger_deposit_instructions_tenant_update ON ledger_deposit_instructions
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE TABLE IF NOT EXISTS ledger_invoice_links (
  invoice_id TEXT PRIMARY KEY REFERENCES ledger_invoices(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  hosted_url TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ledger_invoice_links_tenant_expires
  ON ledger_invoice_links (tenant_id, expires_at DESC);

ALTER TABLE ledger_invoice_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_invoice_links FORCE ROW LEVEL SECURITY;

CREATE POLICY ledger_invoice_links_tenant_read ON ledger_invoice_links
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY ledger_invoice_links_tenant_insert ON ledger_invoice_links
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE ledger_payment_intents
  DROP CONSTRAINT IF EXISTS ledger_payment_intents_action_type_check;

ALTER TABLE ledger_payment_intents
  ADD CONSTRAINT ledger_payment_intents_action_type_check
  CHECK (action_type IN (
    'ach_outbound','ach_inbound','wire','onchain_transfer',
    'erp_writeback','card_payment','x402_settle','escrow_release','exchange','other'
  ));

ALTER TABLE ledger_payment_intents
  DROP CONSTRAINT IF EXISTS ledger_payment_intents_currency_check;

ALTER TABLE ledger_payment_intents
  ADD CONSTRAINT ledger_payment_intents_currency_check
  CHECK (currency ~ '^[A-Z]{3}$' OR currency = 'USDC' OR action_type = 'exchange');

ALTER TABLE ledger_payment_intents
  ADD COLUMN IF NOT EXISTS rate_lock_reference TEXT;

ALTER TABLE ledger_payment_intents
  ADD COLUMN IF NOT EXISTS destination_currency TEXT;

ALTER TABLE ledger_payment_intents
  DROP CONSTRAINT IF EXISTS ledger_payment_intents_exchange_check;

ALTER TABLE ledger_payment_intents
  ADD CONSTRAINT ledger_payment_intents_exchange_check CHECK (
    (
      action_type = 'exchange'
      AND rate_lock_reference IS NOT NULL
      AND destination_currency IS NOT NULL
      AND destination_currency ~ '^[A-Z0-9]{3,6}$'
    )
    OR (
      action_type <> 'exchange'
      AND rate_lock_reference IS NULL
      AND destination_currency IS NULL
    )
  );

COMMIT;
