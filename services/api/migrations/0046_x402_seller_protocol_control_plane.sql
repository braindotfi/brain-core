-- RFC 0012 x402 Phase 1: seller-side protocol and evidence control plane.
--
-- This migration creates no wallet, stores no facilitator credential, sends no
-- payment, and leaves every operation disabled. Settlement and fulfillment
-- evidence is retained for seven years independently of tenant retirement.

BEGIN;

ALTER TABLE x402_operation_price_policies
  DROP CONSTRAINT x402_operation_price_policies_operation_class_revision_key;
ALTER TABLE x402_operation_price_policies
  ADD COLUMN protocol_version INTEGER NOT NULL DEFAULT 2 CHECK (protocol_version = 2),
  ADD COLUMN settlement_timing TEXT NOT NULL DEFAULT 'upfront'
    CHECK (settlement_timing = 'upfront'),
  ADD CONSTRAINT x402_operation_price_policy_network_revision_unique
    UNIQUE (operation_class, network, revision);

INSERT INTO x402_operation_price_policies (
  id, operation_class, revision, scheme, network, asset_symbol,
  asset_decimals, asset_contract, amount_atomic, quote_ttl_seconds,
  facilitator, public, enabled, effective_at, protocol_version,
  settlement_timing
)
VALUES
  (
    'x402_api_base_sepolia_v1', 'api', 1, 'exact', 'eip155:84532', 'USDC',
    6, '0x036CbD53842c5426634e7929541eC2318f3dCF7e', 10000, 60,
    'coinbase_cdp', FALSE, FALSE, '2026-09-13T00:00:00Z', 2, 'upfront'
  ),
  (
    'x402_mcp_base_sepolia_v1', 'mcp', 1, 'exact', 'eip155:84532', 'USDC',
    6, '0x036CbD53842c5426634e7929541eC2318f3dCF7e', 100000, 60,
    'coinbase_cdp', FALSE, FALSE, '2026-09-13T00:00:00Z', 2, 'upfront'
  )
ON CONFLICT (id) DO NOTHING;

CREATE TABLE x402_seller_operation_allowlist (
  id                    TEXT        PRIMARY KEY,
  operation_class       TEXT        NOT NULL CHECK (operation_class IN ('api', 'mcp')),
  operation_id          TEXT        NOT NULL,
  http_method           TEXT        CHECK (http_method IS NULL OR http_method = 'GET'),
  resource_template     TEXT        NOT NULL,
  required_scope        TEXT        NOT NULL CHECK (required_scope IN (
    'ledger:read', 'audit:read', 'governance:read'
  )),
  visibility            TEXT        NOT NULL CHECK (visibility IN ('tenant_private', 'public')),
  api_price_policy_id   TEXT        REFERENCES x402_operation_price_policies(id),
  mcp_price_policy_id   TEXT        REFERENCES x402_operation_price_policies(id),
  enabled               BOOLEAN     NOT NULL DEFAULT FALSE CHECK (enabled = FALSE),
  effective_at          TIMESTAMPTZ NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (operation_class, operation_id),
  CHECK (
    (operation_class = 'api' AND api_price_policy_id IS NOT NULL AND mcp_price_policy_id IS NULL)
    OR
    (operation_class = 'mcp' AND mcp_price_policy_id IS NOT NULL AND api_price_policy_id IS NULL)
  )
);

INSERT INTO x402_seller_operation_allowlist (
  id, operation_class, operation_id, http_method, resource_template,
  required_scope, visibility, api_price_policy_id, mcp_price_policy_id,
  enabled, effective_at
)
VALUES
  ('x402_allow_api_accounts_v1', 'api', 'listAccounts', 'GET', '/ledger/accounts',
    'ledger:read', 'tenant_private', 'x402_api_base_sepolia_v1', NULL, FALSE,
    '2026-09-13T00:00:00Z'),
  ('x402_allow_api_transactions_v1', 'api', 'listTransactions', 'GET', '/ledger/transactions',
    'ledger:read', 'tenant_private', 'x402_api_base_sepolia_v1', NULL, FALSE,
    '2026-09-13T00:00:00Z'),
  ('x402_allow_api_audit_v1', 'api', 'listAuditEvents', 'GET', '/audit/events',
    'audit:read', 'tenant_private', 'x402_api_base_sepolia_v1', NULL, FALSE,
    '2026-09-13T00:00:00Z'),
  ('x402_allow_mcp_accounts_v1', 'mcp', 'ledger.accounts.list', NULL, 'ledger.accounts.list',
    'ledger:read', 'tenant_private', NULL, 'x402_mcp_base_sepolia_v1', FALSE,
    '2026-09-13T00:00:00Z'),
  ('x402_allow_mcp_transactions_v1', 'mcp', 'ledger.transactions.list', NULL,
    'ledger.transactions.list', 'ledger:read', 'tenant_private', NULL,
    'x402_mcp_base_sepolia_v1', FALSE, '2026-09-13T00:00:00Z'),
  ('x402_allow_mcp_obligations_v1', 'mcp', 'ledger.obligations.list', NULL,
    'ledger.obligations.list', 'ledger:read', 'tenant_private', NULL,
    'x402_mcp_base_sepolia_v1', FALSE, '2026-09-13T00:00:00Z')
ON CONFLICT (id) DO NOTHING;

ALTER TABLE api_keys
  ADD COLUMN credential_class TEXT NOT NULL DEFAULT 'commercial_included'
    CHECK (credential_class IN ('commercial_included', 'x402_pay_per_call'));

ALTER TABLE api_keys
  ADD CONSTRAINT api_keys_x402_pay_per_call_scope_ceiling CHECK (
    credential_class <> 'x402_pay_per_call'
    OR scopes <@ ARRAY['ledger:read', 'audit:read', 'governance:read']::TEXT[]
  );

CREATE TABLE x402_seller_logical_operations (
  id                    TEXT        PRIMARY KEY,
  tenant_id             TEXT        REFERENCES tenants(id) ON DELETE SET NULL,
  tenant_reference_sha256 TEXT      NOT NULL CHECK (tenant_reference_sha256 ~ '^[0-9a-f]{64}$'),
  api_key_id            TEXT        REFERENCES api_keys(id) ON DELETE SET NULL,
  operation_policy_id   TEXT        NOT NULL REFERENCES x402_seller_operation_allowlist(id),
  environment           TEXT        NOT NULL CHECK (environment = 'sandbox'),
  request_digest        TEXT        NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  state                 TEXT        NOT NULL CHECK (state IN (
    'allowance_reserved', 'payment_required', 'settled', 'fulfilled',
    'service_failed', 'refund_pending', 'refunded'
  )),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  retain_until          TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 years'),
  UNIQUE (environment, id),
  CHECK (retain_until >= created_at + interval '7 years')
);

CREATE TABLE x402_seller_quotes (
  id                    TEXT        PRIMARY KEY,
  logical_operation_id  TEXT        NOT NULL REFERENCES x402_seller_logical_operations(id),
  price_policy_id       TEXT        NOT NULL REFERENCES x402_operation_price_policies(id),
  quote_digest          TEXT        NOT NULL CHECK (quote_digest ~ '^[0-9a-f]{64}$'),
  nonce_digest          TEXT        NOT NULL CHECK (nonce_digest ~ '^[0-9a-f]{64}$'),
  protocol_version      INTEGER     NOT NULL CHECK (protocol_version = 2),
  scheme                TEXT        NOT NULL CHECK (scheme = 'exact'),
  network               TEXT        NOT NULL CHECK (network = 'eip155:84532'),
  asset_contract        TEXT        NOT NULL,
  recipient_address     TEXT        NOT NULL,
  amount_atomic         BIGINT      NOT NULL CHECK (amount_atomic > 0),
  quoted_at             TIMESTAMPTZ NOT NULL,
  expires_at            TIMESTAMPTZ NOT NULL,
  retain_until          TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 years'),
  CHECK (expires_at > quoted_at AND expires_at <= quoted_at + interval '60 seconds'),
  CHECK (retain_until >= quoted_at + interval '7 years'),
  UNIQUE (logical_operation_id),
  UNIQUE (nonce_digest)
);

CREATE TABLE x402_seller_nonce_consumptions (
  nonce_digest          TEXT        PRIMARY KEY CHECK (nonce_digest ~ '^[0-9a-f]{64}$'),
  quote_id              TEXT        NOT NULL UNIQUE REFERENCES x402_seller_quotes(id),
  payment_payload_digest TEXT       NOT NULL UNIQUE CHECK (
    payment_payload_digest ~ '^[0-9a-f]{64}$'
  ),
  consumed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  retain_until          TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 years'),
  CHECK (retain_until >= consumed_at + interval '7 years')
);

CREATE TABLE x402_seller_receipts (
  id                    TEXT        PRIMARY KEY,
  tenant_id             TEXT        REFERENCES tenants(id) ON DELETE SET NULL,
  tenant_reference_sha256 TEXT      NOT NULL CHECK (tenant_reference_sha256 ~ '^[0-9a-f]{64}$'),
  logical_operation_id  TEXT        NOT NULL UNIQUE REFERENCES x402_seller_logical_operations(id),
  quote_id              TEXT        NOT NULL UNIQUE REFERENCES x402_seller_quotes(id),
  payment_payload_digest TEXT       NOT NULL UNIQUE CHECK (
    payment_payload_digest ~ '^[0-9a-f]{64}$'
  ),
  state                 TEXT        NOT NULL CHECK (state IN (
    'verified', 'settlement_pending', 'settled', 'fulfilled',
    'service_failed', 'refund_pending', 'refunded', 'rejected'
  )),
  payer_address         TEXT,
  settlement_tx_hash    TEXT        UNIQUE,
  refund_tx_hash        TEXT        UNIQUE,
  l2_finality           TEXT        NOT NULL DEFAULT 'not_checked'
    CHECK (l2_finality IN ('not_checked', 'sealed', 'reorged')),
  l1_finality           TEXT        NOT NULL DEFAULT 'not_checked'
    CHECK (l1_finality IN ('not_checked', 'included', 'failed')),
  version               INTEGER     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  retain_until          TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 years'),
  CHECK (
    state NOT IN ('settled', 'fulfilled', 'service_failed', 'refund_pending', 'refunded')
    OR settlement_tx_hash IS NOT NULL
  ),
  CHECK (retain_until >= created_at + interval '7 years')
);

CREATE TABLE x402_seller_settlement_events (
  id                    TEXT        PRIMARY KEY,
  receipt_id            TEXT        NOT NULL REFERENCES x402_seller_receipts(id),
  sequence              INTEGER     NOT NULL CHECK (sequence > 0),
  event_kind            TEXT        NOT NULL CHECK (event_kind IN (
    'verified', 'rejected', 'settlement_pending', 'settled', 'l2_sealed',
    'l2_reorged', 'l1_included', 'l1_failed', 'fulfilled', 'service_failed',
    'refund_pending', 'refunded', 'reconciled'
  )),
  facilitator_request_id TEXT,
  transaction_hash      TEXT,
  evidence_digest       TEXT        NOT NULL CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
  evidence              JSONB       NOT NULL,
  occurred_at           TIMESTAMPTZ NOT NULL,
  recorded_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  retain_until          TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 years'),
  UNIQUE (receipt_id, sequence),
  CHECK (retain_until >= occurred_at + interval '7 years')
);

CREATE OR REPLACE FUNCTION reserve_x402_allowance_unit(
  p_tenant_id TEXT,
  p_operation_class TEXT,
  p_period_start TIMESTAMPTZ,
  p_logical_operation_id TEXT,
  p_reservation_id TEXT,
  p_now TIMESTAMPTZ DEFAULT now()
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  updated_rows INTEGER;
BEGIN
  IF p_tenant_id IS NULL OR p_tenant_id IS DISTINCT FROM NULLIF(current_setting('app.tenant_id', true), '') THEN
    RAISE EXCEPTION 'x402 allowance reservation tenant does not match request context'
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.api_usage_allowance_reservations
     WHERE tenant_id = p_tenant_id
       AND operation_class = p_operation_class
       AND period_start = p_period_start
       AND logical_operation_id = p_logical_operation_id
  ) THEN
    RETURN TRUE;
  END IF;

  UPDATE public.api_usage_allowance_counters
     SET reserved_units = reserved_units + 1,
         version = version + 1,
         updated_at = p_now
   WHERE tenant_id = p_tenant_id
     AND operation_class = p_operation_class
     AND period_start = p_period_start
     AND consumed_units + reserved_units < allowance_units;
  GET DIAGNOSTICS updated_rows = ROW_COUNT;
  IF updated_rows = 0 THEN
    RETURN FALSE;
  END IF;

  INSERT INTO public.api_usage_allowance_reservations (
    id, tenant_id, operation_class, period_start, logical_operation_id,
    units, status, expires_at, created_at
  ) VALUES (
    p_reservation_id, p_tenant_id, p_operation_class, p_period_start,
    p_logical_operation_id, 1, 'reserved', p_now + interval '5 minutes', p_now
  );
  RETURN TRUE;
EXCEPTION WHEN unique_violation THEN
  -- A concurrent retry won the unique logical-operation insert. The exception
  -- subtransaction rolls back this attempt's counter increment.
  RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION reject_x402_seller_immutable_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'x402 seller evidence is append-only';
END;
$$;

CREATE TRIGGER x402_price_policies_immutable
BEFORE UPDATE OR DELETE ON x402_operation_price_policies
FOR EACH ROW EXECUTE FUNCTION reject_x402_seller_immutable_mutation();
CREATE TRIGGER x402_price_policies_no_truncate
BEFORE TRUNCATE ON x402_operation_price_policies
FOR EACH STATEMENT EXECUTE FUNCTION reject_x402_seller_immutable_mutation();
CREATE TRIGGER x402_operation_allowlist_immutable
BEFORE UPDATE OR DELETE ON x402_seller_operation_allowlist
FOR EACH ROW EXECUTE FUNCTION reject_x402_seller_immutable_mutation();
CREATE TRIGGER x402_operation_allowlist_no_truncate
BEFORE TRUNCATE ON x402_seller_operation_allowlist
FOR EACH STATEMENT EXECUTE FUNCTION reject_x402_seller_immutable_mutation();
CREATE TRIGGER x402_quotes_immutable
BEFORE UPDATE OR DELETE ON x402_seller_quotes
FOR EACH ROW EXECUTE FUNCTION reject_x402_seller_immutable_mutation();
CREATE TRIGGER x402_quotes_no_truncate
BEFORE TRUNCATE ON x402_seller_quotes
FOR EACH STATEMENT EXECUTE FUNCTION reject_x402_seller_immutable_mutation();
CREATE TRIGGER x402_nonce_consumptions_immutable
BEFORE UPDATE OR DELETE ON x402_seller_nonce_consumptions
FOR EACH ROW EXECUTE FUNCTION reject_x402_seller_immutable_mutation();
CREATE TRIGGER x402_nonce_consumptions_no_truncate
BEFORE TRUNCATE ON x402_seller_nonce_consumptions
FOR EACH STATEMENT EXECUTE FUNCTION reject_x402_seller_immutable_mutation();
CREATE TRIGGER x402_settlement_events_immutable
BEFORE UPDATE OR DELETE ON x402_seller_settlement_events
FOR EACH ROW EXECUTE FUNCTION reject_x402_seller_immutable_mutation();
CREATE TRIGGER x402_settlement_events_no_truncate
BEFORE TRUNCATE ON x402_seller_settlement_events
FOR EACH STATEMENT EXECUTE FUNCTION reject_x402_seller_immutable_mutation();

ALTER TABLE x402_seller_logical_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE x402_seller_logical_operations FORCE ROW LEVEL SECURITY;
ALTER TABLE x402_seller_quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE x402_seller_quotes FORCE ROW LEVEL SECURITY;
ALTER TABLE x402_seller_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE x402_seller_receipts FORCE ROW LEVEL SECURITY;

CREATE POLICY x402_seller_logical_operations_tenant ON x402_seller_logical_operations
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY x402_seller_quotes_tenant ON x402_seller_quotes
  USING (logical_operation_id IN (
    SELECT id FROM x402_seller_logical_operations
     WHERE tenant_id = current_setting('app.tenant_id', true)
  ));
CREATE POLICY x402_seller_receipts_tenant ON x402_seller_receipts
  USING (tenant_id = current_setting('app.tenant_id', true));

REVOKE ALL PRIVILEGES ON x402_seller_operation_allowlist,
  x402_seller_logical_operations, x402_seller_quotes,
  x402_seller_nonce_consumptions, x402_seller_receipts,
  x402_seller_settlement_events FROM PUBLIC;
REVOKE ALL ON FUNCTION reserve_x402_allowance_unit(
  TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TIMESTAMPTZ
) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brain_app') THEN
    GRANT SELECT ON x402_seller_operation_allowlist,
      x402_seller_logical_operations, x402_seller_quotes,
      x402_seller_receipts TO brain_app;
    GRANT EXECUTE ON FUNCTION reserve_x402_allowance_unit(
      TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TIMESTAMPTZ
    ) TO brain_app;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON x402_seller_operation_allowlist,
      x402_seller_logical_operations, x402_seller_quotes,
      x402_seller_nonce_consumptions, x402_seller_receipts,
      x402_seller_settlement_events FROM brain_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brain_privileged') THEN
    GRANT SELECT ON x402_seller_operation_allowlist,
      x402_seller_logical_operations, x402_seller_quotes,
      x402_seller_nonce_consumptions, x402_seller_receipts,
      x402_seller_settlement_events TO brain_privileged;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON x402_seller_operation_allowlist,
      x402_seller_logical_operations, x402_seller_quotes,
      x402_seller_nonce_consumptions, x402_seller_receipts,
      x402_seller_settlement_events FROM brain_privileged;
  END IF;
END $$;

COMMENT ON TABLE x402_seller_operation_allowlist IS
  'Fixed read-only launch ceiling. All entries remain disabled in Phase 1.';
COMMENT ON TABLE x402_seller_settlement_events IS
  'Append-only verification, settlement, finality, fulfillment, refund, and reconciliation evidence.';
COMMENT ON TABLE x402_seller_receipts IS
  'Bounded authoritative current-state projection. Audit history is not a query dependency.';
COMMENT ON COLUMN api_keys.credential_class IS
  'Separates included commercial keys from no-allowance x402 pay-per-call keys.';

COMMIT;
