-- Brain Ledger — payment_intents.
-- Source of truth: Brain_MVP_Architecture.md §3 Layer 2 + §3 Layer 5.
--
-- A PaymentIntent is the only Ledger row created by an agent rather than
-- by Raw extraction. It is governed by §9.5 of Engineering Standards
-- (state machine: proposed → pending_approval → approved → executed,
-- with cancelled/rejected/failed terminals) and §6 (the 13-step
-- pre-execution gate that runs before transitioning to executed).
--
-- The row lives in Ledger because callers need to query it like any
-- other Ledger entity ("what payments are pending?"). Lifecycle
-- mutations are owned by services/agent (Phase 4 of refactor).

BEGIN;

CREATE TABLE IF NOT EXISTS ledger_payment_intents (
  id                          TEXT        PRIMARY KEY,                  -- pi_<ulid>
  owner_id                    TEXT        NOT NULL,
  created_by_agent_id         TEXT,                                     -- agents.id; nullable for human-initiated
  action_type                 TEXT        NOT NULL
                                CHECK (action_type IN (
                                  'ach_outbound','ach_inbound','wire',
                                  'onchain_transfer','erp_writeback','card_payment','other'
                                )),
  source_account_id           TEXT        NOT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  destination_counterparty_id TEXT        NOT NULL REFERENCES ledger_counterparties(id) ON DELETE RESTRICT,
  amount                      NUMERIC(28, 8) NOT NULL CHECK (amount > 0),
  currency                    TEXT        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  obligation_id               TEXT        REFERENCES ledger_obligations(id) ON DELETE SET NULL,
  invoice_id                  TEXT        REFERENCES ledger_invoices(id) ON DELETE SET NULL,
  status                      TEXT        NOT NULL
                                CHECK (status IN (
                                  'proposed','pending_approval','approved',
                                  'rejected','executed','failed','cancelled'
                                )),
  policy_decision_id          TEXT,                                     -- references the §6 PolicyDecision row
  approval_ids                TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  execution_receipt_ids       TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  source_ids                  TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  evidence_ids                TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  provenance                  TEXT        NOT NULL DEFAULT 'inferred'
                                CHECK (provenance IN (
                                  'extracted','inferred','ambiguous','human_confirmed','agent_contributed'
                                )),
  confidence                  REAL        NOT NULL DEFAULT 1.0
                                CHECK (confidence >= 0.0 AND confidence <= 1.0),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ledger_payment_intents_owner_status
  ON ledger_payment_intents (owner_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ledger_payment_intents_owner_agent
  ON ledger_payment_intents (owner_id, created_by_agent_id)
  WHERE created_by_agent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ledger_payment_intents_owner_obligation
  ON ledger_payment_intents (owner_id, obligation_id)
  WHERE obligation_id IS NOT NULL;

ALTER TABLE ledger_payment_intents ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ledger_payment_intents
  USING (owner_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON ledger_payment_intents
  FOR INSERT WITH CHECK (owner_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON ledger_payment_intents
  FOR UPDATE USING (owner_id = current_setting('app.tenant_id', true))
             WITH CHECK (owner_id = current_setting('app.tenant_id', true));

COMMIT;
