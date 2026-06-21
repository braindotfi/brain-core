-- ledger_reservations — balance reservations held from durable handoff until
-- terminal settlement/failure
-- (Agent Autonomy v3, 1b.1). With multiple money-movers active, parallel
-- proposers race on available_balance; an active reservation makes gate check #8
-- subtract in-flight commitments. owner_id is the tenant column on Ledger tables.

BEGIN;

CREATE TABLE IF NOT EXISTS ledger_reservations (
  id                  TEXT        PRIMARY KEY,             -- rsv_...
  owner_id            TEXT        NOT NULL,
  account_id          TEXT        NOT NULL,
  amount              NUMERIC(28, 8) NOT NULL CHECK (amount > 0),
  currency            TEXT        NOT NULL,
  payment_intent_id   TEXT        NOT NULL,
  policy_decision_id  TEXT        NOT NULL,
  reserving_agent_id  TEXT        NOT NULL,
  reserved_until      TIMESTAMPTZ NOT NULL,                -- stale-row ops TTL, not settlement hold
  status              TEXT        NOT NULL                 -- active|consumed|released|expired
                       CHECK (status IN ('active', 'consumed', 'released', 'expired')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Partial index: the only hot query is "sum active reservations for this account".
CREATE INDEX IF NOT EXISTS idx_ledger_reservations_account_active
  ON ledger_reservations (account_id, status)
  WHERE status = 'active';

ALTER TABLE ledger_reservations ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ledger_reservations
  USING (owner_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON ledger_reservations
  FOR INSERT WITH CHECK (owner_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON ledger_reservations
  FOR UPDATE USING (owner_id = current_setting('app.tenant_id', true))
             WITH CHECK (owner_id = current_setting('app.tenant_id', true));

COMMIT;
