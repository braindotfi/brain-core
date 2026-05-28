-- Counterparty payment-instruction change history.
--
-- Backs §6 gate check 11.5, rule 6 (destination_recently_changed) — the
-- strongest fraud signal in the duplicate-detector: a vendor account swap
-- within a 24h window. Before this migration the rule referenced a non-existent
-- relation, which made the gate throw on every payment intent. This creates the
-- table empty so the rule degrades to "no signal yet" rather than crashing.
--
-- Population is a follow-up (Wiki/Ledger writer responsibility): every time a
-- counterparty's payee/bank-account fields change we insert one row here with
-- the prior + new instruction hashes so the rule can detect a swap. Until that
-- writer is wired the table is empty and rule 6 always passes.
--
-- The detector queries `changed_at` only; the other columns are stored for
-- forensic / audit replay.

BEGIN;

CREATE TABLE IF NOT EXISTS ledger_counterparty_payment_instructions (
  id                TEXT        PRIMARY KEY,                  -- cpi_<ulid>
  owner_id          TEXT        NOT NULL,                     -- tenant id (RLS column)
  counterparty_id   TEXT        NOT NULL,                     -- ledger_counterparties.id
  changed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  prior_hash        TEXT,                                     -- sha256 of the previous instruction (null at first record)
  current_hash      TEXT        NOT NULL,                     -- sha256 of the new instruction
  source_id         TEXT,                                     -- raw_artifacts row that motivated the change (when known)
  actor             TEXT,                                     -- user/agent that wrote the change
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cp_pay_instructions_counterparty_changed
  ON ledger_counterparty_payment_instructions (owner_id, counterparty_id, changed_at DESC);

ALTER TABLE ledger_counterparty_payment_instructions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_counterparty_payment_instructions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ledger_counterparty_payment_instructions
  USING (owner_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON ledger_counterparty_payment_instructions
  FOR INSERT WITH CHECK (owner_id = current_setting('app.tenant_id', true));
-- No UPDATE / DELETE policies: this is an append-only history table.

COMMENT ON TABLE ledger_counterparty_payment_instructions IS
  'Append-only history of counterparty payee/bank-account changes. Read by the §6 gate (check 11.5 rule 6) to fail-close on a same-vendor account swap within a 24h window. Population is a Ledger-writer responsibility.';

COMMIT;
