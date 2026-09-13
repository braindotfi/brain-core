-- RFC 0009 Stripe Phase 1: test-mode control plane and immutable evidence.
--
-- This migration creates no Stripe object, stores no Stripe credential, and
-- leaves commercial billing disabled. Live-mode provider data is rejected by
-- database constraints until a later, separately reviewed migration.

BEGIN;

CREATE TABLE commercial_stripe_customers (
  id                    TEXT        PRIMARY KEY,
  billing_account_id    TEXT        NOT NULL REFERENCES commercial_billing_accounts(id),
  provider_mode         TEXT        NOT NULL DEFAULT 'test' CHECK (provider_mode = 'test'),
  stripe_customer_id    TEXT        NOT NULL,
  livemode              BOOLEAN     NOT NULL CHECK (livemode = FALSE),
  provider_api_version  TEXT        NOT NULL CHECK (provider_api_version = '2026-02-25.clover'),
  status                TEXT        NOT NULL CHECK (status IN ('active', 'archived')),
  version               INTEGER     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (billing_account_id, provider_mode),
  UNIQUE (provider_mode, stripe_customer_id)
);

CREATE TABLE commercial_stripe_price_bindings (
  id                    TEXT        PRIMARY KEY,
  price_revision_id     TEXT        NOT NULL REFERENCES commercial_tier_prices(id),
  provider_mode         TEXT        NOT NULL DEFAULT 'test' CHECK (provider_mode = 'test'),
  stripe_product_id     TEXT        NOT NULL,
  stripe_price_id       TEXT        NOT NULL,
  livemode              BOOLEAN     NOT NULL CHECK (livemode = FALSE),
  provider_api_version  TEXT        NOT NULL CHECK (provider_api_version = '2026-02-25.clover'),
  price_book_digest     TEXT        NOT NULL CHECK (price_book_digest ~ '^[0-9a-f]{64}$'),
  created_by            TEXT        NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (price_revision_id, provider_mode),
  UNIQUE (provider_mode, stripe_price_id)
);

CREATE TABLE commercial_stripe_webhook_inbox (
  id                    TEXT        PRIMARY KEY,
  provider_mode         TEXT        NOT NULL DEFAULT 'test' CHECK (provider_mode = 'test'),
  stripe_event_id       TEXT        NOT NULL,
  event_type            TEXT        NOT NULL,
  event_created_at      TIMESTAMPTZ NOT NULL,
  livemode              BOOLEAN     NOT NULL CHECK (livemode = FALSE),
  provider_api_version  TEXT        NOT NULL CHECK (provider_api_version = '2026-02-25.clover'),
  webhook_version       TEXT        NOT NULL CHECK (webhook_version = '2026-02-25.clover'),
  raw_body_sha256       TEXT        NOT NULL CHECK (raw_body_sha256 ~ '^[0-9a-f]{64}$'),
  payload               JSONB       NOT NULL,
  signature_created_at  TIMESTAMPTZ NOT NULL,
  received_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider_mode, stripe_event_id)
);

CREATE TABLE commercial_stripe_webhook_processing_attempts (
  id                    TEXT        PRIMARY KEY,
  inbox_id              TEXT        NOT NULL REFERENCES commercial_stripe_webhook_inbox(id),
  attempt_number        INTEGER     NOT NULL CHECK (attempt_number > 0),
  outcome               TEXT        NOT NULL CHECK (outcome IN (
    'applied', 'ignored', 'retryable_failure', 'terminal_failure'
  )),
  failure_code          TEXT,
  provider_request_id   TEXT,
  projection_version    INTEGER,
  attempted_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (outcome IN ('retryable_failure', 'terminal_failure') AND failure_code IS NOT NULL)
    OR (outcome IN ('applied', 'ignored') AND failure_code IS NULL)
  ),
  UNIQUE (inbox_id, attempt_number)
);

CREATE TABLE commercial_stripe_catalog_operation_receipts (
  id                    TEXT        PRIMARY KEY,
  action                TEXT        NOT NULL CHECK (action IN ('inspect', 'plan', 'apply', 'verify')),
  provider_mode         TEXT        NOT NULL DEFAULT 'test' CHECK (provider_mode = 'test'),
  idempotency_key       TEXT        NOT NULL,
  request_digest        TEXT        NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  catalog_revision      INTEGER     NOT NULL CHECK (catalog_revision > 0),
  provider_api_version  TEXT        NOT NULL CHECK (provider_api_version = '2026-02-25.clover'),
  result                JSONB       NOT NULL,
  completed_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider_mode, action, idempotency_key),
  UNIQUE (provider_mode, action, request_digest)
);

CREATE INDEX idx_commercial_stripe_webhook_inbox_received
  ON commercial_stripe_webhook_inbox (received_at, id);
CREATE INDEX idx_commercial_stripe_webhook_attempts_inbox
  ON commercial_stripe_webhook_processing_attempts (inbox_id, attempt_number);

CREATE OR REPLACE FUNCTION reject_commercial_stripe_immutable_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'commercial Stripe evidence is append-only';
END;
$$;

CREATE TRIGGER commercial_stripe_price_bindings_immutable
BEFORE UPDATE OR DELETE ON commercial_stripe_price_bindings
FOR EACH ROW EXECUTE FUNCTION reject_commercial_stripe_immutable_mutation();
CREATE TRIGGER commercial_stripe_price_bindings_no_truncate
BEFORE TRUNCATE ON commercial_stripe_price_bindings
FOR EACH STATEMENT EXECUTE FUNCTION reject_commercial_stripe_immutable_mutation();

CREATE TRIGGER commercial_stripe_webhook_inbox_immutable
BEFORE UPDATE OR DELETE ON commercial_stripe_webhook_inbox
FOR EACH ROW EXECUTE FUNCTION reject_commercial_stripe_immutable_mutation();
CREATE TRIGGER commercial_stripe_webhook_inbox_no_truncate
BEFORE TRUNCATE ON commercial_stripe_webhook_inbox
FOR EACH STATEMENT EXECUTE FUNCTION reject_commercial_stripe_immutable_mutation();

CREATE TRIGGER commercial_stripe_webhook_attempts_immutable
BEFORE UPDATE OR DELETE ON commercial_stripe_webhook_processing_attempts
FOR EACH ROW EXECUTE FUNCTION reject_commercial_stripe_immutable_mutation();
CREATE TRIGGER commercial_stripe_webhook_attempts_no_truncate
BEFORE TRUNCATE ON commercial_stripe_webhook_processing_attempts
FOR EACH STATEMENT EXECUTE FUNCTION reject_commercial_stripe_immutable_mutation();

CREATE TRIGGER commercial_stripe_catalog_receipts_immutable
BEFORE UPDATE OR DELETE ON commercial_stripe_catalog_operation_receipts
FOR EACH ROW EXECUTE FUNCTION reject_commercial_stripe_immutable_mutation();
CREATE TRIGGER commercial_stripe_catalog_receipts_no_truncate
BEFORE TRUNCATE ON commercial_stripe_catalog_operation_receipts
FOR EACH STATEMENT EXECUTE FUNCTION reject_commercial_stripe_immutable_mutation();

REVOKE ALL PRIVILEGES ON commercial_stripe_customers,
  commercial_stripe_price_bindings, commercial_stripe_webhook_inbox,
  commercial_stripe_webhook_processing_attempts,
  commercial_stripe_catalog_operation_receipts FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brain_app') THEN
    GRANT SELECT ON commercial_stripe_customers,
      commercial_stripe_price_bindings TO brain_app;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON commercial_stripe_customers,
      commercial_stripe_price_bindings, commercial_stripe_webhook_inbox,
      commercial_stripe_webhook_processing_attempts,
      commercial_stripe_catalog_operation_receipts FROM brain_app;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brain_privileged') THEN
    GRANT SELECT ON commercial_stripe_customers,
      commercial_stripe_price_bindings, commercial_stripe_webhook_inbox,
      commercial_stripe_webhook_processing_attempts,
      commercial_stripe_catalog_operation_receipts TO brain_privileged;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON commercial_stripe_customers,
      commercial_stripe_price_bindings, commercial_stripe_webhook_inbox,
      commercial_stripe_webhook_processing_attempts,
      commercial_stripe_catalog_operation_receipts FROM brain_privileged;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brain_stripe_billing_worker') THEN
    GRANT SELECT, INSERT, UPDATE ON commercial_stripe_customers TO brain_stripe_billing_worker;
    GRANT SELECT, INSERT ON commercial_stripe_price_bindings,
      commercial_stripe_webhook_inbox,
      commercial_stripe_webhook_processing_attempts,
      commercial_stripe_catalog_operation_receipts TO brain_stripe_billing_worker;
    REVOKE DELETE, TRUNCATE ON commercial_stripe_customers,
      commercial_stripe_price_bindings, commercial_stripe_webhook_inbox,
      commercial_stripe_webhook_processing_attempts,
      commercial_stripe_catalog_operation_receipts FROM brain_stripe_billing_worker;
    REVOKE UPDATE ON commercial_stripe_price_bindings,
      commercial_stripe_webhook_inbox,
      commercial_stripe_webhook_processing_attempts,
      commercial_stripe_catalog_operation_receipts FROM brain_stripe_billing_worker;
  END IF;
END $$;

COMMENT ON TABLE commercial_stripe_customers IS
  'Durable test-mode Stripe Customer projection keyed by Brain billing account.';
COMMENT ON TABLE commercial_stripe_price_bindings IS
  'Immutable binding from a Brain price-book revision to test-mode Stripe Product and Price ids.';
COMMENT ON TABLE commercial_stripe_webhook_inbox IS
  'Append-only commercial billing webhook inbox. Distinct from tenant Stripe source ingestion.';
COMMENT ON TABLE commercial_stripe_catalog_operation_receipts IS
  'Idempotent evidence for inspect, plan, apply, and verify catalog operator actions.';

COMMIT;
