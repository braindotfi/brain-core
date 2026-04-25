-- Brain Ledger — reconciliation_matches.
-- Source of truth: Brain_MVP_Architecture.md §3 Layer 2.
--
-- A match between two Ledger entities. The seven match_types defined in
-- §3 Layer 2 cover the MVP reconciliation engine (Phase 5). Generic
-- left/right entity references avoid 7 separate tables for what is the
-- same shape — match validation logic lives in the Reconciliation
-- service.
--
-- Note: no FK constraint on left/right entity ids because the entity_type
-- determines which table they reference. The reconciliation service
-- validates referential integrity before insert; downstream readers
-- defend by checking entity_type before joining.

BEGIN;

CREATE TABLE IF NOT EXISTS ledger_reconciliation_matches (
  id                  TEXT        PRIMARY KEY,                  -- rcn_<ulid>
  owner_id            TEXT        NOT NULL,
  match_type          TEXT        NOT NULL
                        CHECK (match_type IN (
                          'transaction_receipt','invoice_payment','statement_balance',
                          'wallet_transfer','payroll_bank_debit','subscription_charge',
                          'card_charge'
                        )),
  left_entity_type    TEXT        NOT NULL
                        CHECK (left_entity_type IN (
                          'transaction','invoice','obligation','document','balance','transfer'
                        )),
  left_entity_id      TEXT        NOT NULL,
  right_entity_type   TEXT        NOT NULL
                        CHECK (right_entity_type IN (
                          'transaction','invoice','obligation','document','balance','transfer'
                        )),
  right_entity_id     TEXT        NOT NULL,
  confidence_score    REAL        NOT NULL CHECK (confidence_score >= 0.0 AND confidence_score <= 1.0),
  status              TEXT        NOT NULL
                        CHECK (status IN (
                          'unmatched','matched','partially_matched','duplicate_possible',
                          'disputed','cleared','failed','reversed'
                        )),
  evidence_ids        TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  explanation         TEXT,                                     -- short prose for the wiki page
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A given pair (in order) can appear in only one active match. Reverse-order
  -- matches are NOT prevented at the DB level because match_type semantics
  -- can differ (subscription_charge vs card_charge can both touch the same
  -- transaction). The reconciliation service enforces business uniqueness.
  UNIQUE (owner_id, match_type, left_entity_type, left_entity_id, right_entity_type, right_entity_id)
);

CREATE INDEX IF NOT EXISTS idx_ledger_recon_owner_status
  ON ledger_reconciliation_matches (owner_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ledger_recon_left
  ON ledger_reconciliation_matches (owner_id, left_entity_type, left_entity_id);

CREATE INDEX IF NOT EXISTS idx_ledger_recon_right
  ON ledger_reconciliation_matches (owner_id, right_entity_type, right_entity_id);

ALTER TABLE ledger_reconciliation_matches ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ledger_reconciliation_matches
  USING (owner_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON ledger_reconciliation_matches
  FOR INSERT WITH CHECK (owner_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON ledger_reconciliation_matches
  FOR UPDATE USING (owner_id = current_setting('app.tenant_id', true))
             WITH CHECK (owner_id = current_setting('app.tenant_id', true));

COMMIT;
