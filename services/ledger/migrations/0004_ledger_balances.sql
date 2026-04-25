-- Brain Ledger — balances (point-in-time snapshots).
-- Source of truth: Brain_MVP_Architecture.md §3 Layer 2.
--
-- Account holds the latest balance for the hot path. This table holds
-- history so we can answer "what was my balance on March 14?" without
-- reconstructing from the transaction stream every time.

BEGIN;

CREATE TABLE IF NOT EXISTS ledger_balances (
  id                  TEXT        PRIMARY KEY,                 -- bal_<ulid>
  owner_id            TEXT        NOT NULL,
  account_id          TEXT        NOT NULL REFERENCES ledger_accounts(id) ON DELETE CASCADE,
  as_of               TIMESTAMPTZ NOT NULL,
  current_balance     NUMERIC(28, 8) NOT NULL,
  available_balance   NUMERIC(28, 8),
  pending_balance     NUMERIC(28, 8),
  currency            TEXT        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  source_ids          TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  evidence_ids        TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  provenance          TEXT        NOT NULL
                        CHECK (provenance IN (
                          'extracted','inferred','ambiguous','human_confirmed','agent_contributed'
                        )),
  confidence          REAL        NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Idempotency: a (account, as_of) snapshot is unique per source. Allows
  -- reingestion of Plaid balance webhooks without dup rows.
  UNIQUE (account_id, as_of)
);

CREATE INDEX IF NOT EXISTS idx_ledger_balances_owner_account_asof
  ON ledger_balances (owner_id, account_id, as_of DESC);

ALTER TABLE ledger_balances ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ledger_balances
  USING (owner_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON ledger_balances
  FOR INSERT WITH CHECK (owner_id = current_setting('app.tenant_id', true));

COMMIT;
