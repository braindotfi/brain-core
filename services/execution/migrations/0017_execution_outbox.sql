-- H-04 durable execution outbox + saga.
--
-- PaymentIntentService.execute used to run gate → audit-before → rails.dispatch
-- → audit-after → state transition synchronously. A crash between rail dispatch
-- and the final state write left money moved with no internal record of
-- completion. The outbox makes that boundary durable: execute atomically
-- enqueues a `pending` row here and moves the intent approved → dispatching in
-- the SAME transaction; a poll-based worker (FOR UPDATE SKIP LOCKED) then
-- dispatches the rail and settles the intent. A crash leaves the row claimable.
--
-- RLS is armed here (ENABLE) and is only ENFORCED under the non-owner brain_app
-- role + FORCE ROW LEVEL SECURITY from infra/db-roles.sql (Standards §1.2); the
-- worker uses the request-path tenant scope (withTenantScope sets app.tenant_id),
-- never a cross-tenant scan.

BEGIN;

CREATE TABLE IF NOT EXISTS execution_outbox (
  id                  TEXT        PRIMARY KEY,                  -- exo_<ulid>
  tenant_id           TEXT        NOT NULL,
  payment_intent_id   TEXT        NOT NULL,
  execution_id        TEXT,                                     -- minted by the worker on dispatch
  rail                TEXT        NOT NULL,
  idempotency_key     TEXT        NOT NULL,
  payload             JSONB       NOT NULL,                     -- canonical rail dispatch payload
  payload_hash        BYTEA       NOT NULL,                     -- sha256 of canonical_json(payload)
  status              TEXT        NOT NULL DEFAULT 'pending'
                        CHECK (status IN
                          ('pending', 'dispatching', 'dispatched', 'settled',
                           'failed', 'reconciling')),
  attempt_count       INT         NOT NULL DEFAULT 0,
  last_error          TEXT,
  rail_receipt        JSONB,
  audit_before_id     TEXT        NOT NULL,
  audit_after_id      TEXT,
  reservation_id      TEXT,                                     -- from ledger_reservations
  locked_at           TIMESTAMPTZ,
  locked_by           TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  dispatched_at       TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  UNIQUE (tenant_id, idempotency_key)
);

ALTER TABLE execution_outbox ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON execution_outbox
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON execution_outbox
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON execution_outbox
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
             WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

-- Claim index for the worker poll: only rows that still need work.
CREATE INDEX IF NOT EXISTS idx_execution_outbox_pending
  ON execution_outbox (status, created_at)
  WHERE status IN ('pending', 'reconciling');

COMMIT;
