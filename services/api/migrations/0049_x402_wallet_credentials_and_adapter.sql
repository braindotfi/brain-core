-- RFC 0012 x402 Phase 2: wallet registry, pay-per-call credentials, and
-- counterfactual settlement evidence. No operation is enabled by this change.

BEGIN;

CREATE TABLE x402_seller_wallets (
  id                    TEXT        PRIMARY KEY,
  label                 TEXT        NOT NULL UNIQUE,
  environment           TEXT        NOT NULL CHECK (environment IN ('sandbox', 'live')),
  network               TEXT        NOT NULL,
  address               TEXT        NOT NULL CHECK (address ~ '^0x[0-9A-Fa-f]{40}$'),
  custody               TEXT        NOT NULL CHECK (custody IN ('retired_external', 'azure_managed_hsm')),
  hsm_key_versioned_id  TEXT,
  status                TEXT        NOT NULL CHECK (status IN ('pending_activation', 'active', 'retired')),
  may_receive           BOOLEAN     NOT NULL,
  may_sign              BOOLEAN     NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at            TIMESTAMPTZ,
  UNIQUE (environment, network, address),
  CHECK (
    (status = 'retired' AND may_receive = FALSE AND may_sign = FALSE AND retired_at IS NOT NULL)
    OR (status <> 'retired' AND retired_at IS NULL)
  ),
  CHECK (
    custody <> 'azure_managed_hsm'
    OR (hsm_key_versioned_id IS NOT NULL AND network = 'eip155:84532')
  )
);

INSERT INTO x402_seller_wallets (
  id, label, environment, network, address, custody, status,
  may_receive, may_sign, created_at, retired_at
)
VALUES (
  'x402wallet_rfc0008_retired', 'rfc0008_test_receiver_retired', 'sandbox',
  'eip155:84532', '0x5e22088C527e2C112dbe47ceADca94db9Aa19497',
  'retired_external', 'retired', FALSE, FALSE,
  '2026-09-16T00:00:00Z', '2026-09-16T00:00:00Z'
)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE x402_api_key_operation_grants (
  id                    TEXT        PRIMARY KEY,
  tenant_id             TEXT        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  api_key_id            TEXT        NOT NULL,
  operation_policy_id   TEXT        NOT NULL REFERENCES x402_seller_operation_allowlist(id),
  granted_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at            TIMESTAMPTZ NOT NULL,
  UNIQUE (api_key_id, operation_policy_id),
  FOREIGN KEY (tenant_id, api_key_id)
    REFERENCES api_keys(tenant_id, id) ON DELETE CASCADE,
  CHECK (expires_at > granted_at)
);

ALTER TABLE api_keys
  ADD CONSTRAINT api_keys_x402_prefix_and_lifetime CHECK (
    (
      credential_class <> 'x402_pay_per_call'
      AND key_prefix NOT IN ('brain_xk_test_', 'brain_xk_live_')
    )
    OR (
      credential_class = 'x402_pay_per_call'
      AND
      expires_at IS NOT NULL
      AND (
        (environment = 'sandbox' AND key_prefix = 'brain_xk_test_'
          AND expires_at <= created_at + interval '30 days')
        OR
        (environment = 'live' AND key_prefix = 'brain_xk_live_'
          AND expires_at <= created_at + interval '90 days')
      )
    )
  );

CREATE OR REPLACE FUNCTION enforce_x402_api_key_grant_contract()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  key_row api_keys%ROWTYPE;
  max_lifetime INTERVAL;
BEGIN
  SELECT * INTO key_row FROM api_keys WHERE id = NEW.api_key_id FOR SHARE;
  IF NOT FOUND OR key_row.tenant_id <> NEW.tenant_id THEN
    RAISE EXCEPTION 'x402 operation grant key and tenant do not match';
  END IF;
  IF key_row.credential_class <> 'x402_pay_per_call' THEN
    RAISE EXCEPTION 'x402 operation grant requires x402_pay_per_call credential class';
  END IF;
  max_lifetime := CASE key_row.environment
    WHEN 'sandbox' THEN interval '30 days'
    WHEN 'live' THEN interval '90 days'
    ELSE NULL
  END;
  IF key_row.expires_at IS NULL
     OR key_row.expires_at > key_row.created_at + max_lifetime
     OR NEW.expires_at > key_row.expires_at THEN
    RAISE EXCEPTION 'x402 operation grant exceeds credential lifetime';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM x402_seller_operation_allowlist
     WHERE id = NEW.operation_policy_id
       AND operation_id IN (
         'listAccounts', 'listTransactions', 'listAuditEvents',
         'ledger.accounts.list', 'ledger.transactions.list',
         'ledger.obligations.list'
       )
  ) THEN
    RAISE EXCEPTION 'x402 operation is outside the fixed launch allowlist';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER x402_api_key_grants_contract
BEFORE INSERT ON x402_api_key_operation_grants
FOR EACH ROW EXECUTE FUNCTION enforce_x402_api_key_grant_contract();

CREATE TABLE x402_counterfactual_observations (
  id                    TEXT        PRIMARY KEY,
  tenant_id             TEXT        REFERENCES tenants(id) ON DELETE SET NULL,
  tenant_reference_sha256 TEXT      NOT NULL CHECK (tenant_reference_sha256 ~ '^[0-9a-f]{64}$'),
  operation_policy_id   TEXT        NOT NULL REFERENCES x402_seller_operation_allowlist(id),
  request_digest        TEXT        NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  price_policy_id       TEXT        NOT NULL REFERENCES x402_operation_price_policies(id),
  allowance_outcome     TEXT        NOT NULL CHECK (allowance_outcome IN ('within', 'over', 'unresolved')),
  quote_amount_atomic   BIGINT      NOT NULL CHECK (quote_amount_atomic > 0),
  facilitator_outcome   TEXT        NOT NULL CHECK (facilitator_outcome IN (
    'not_attempted', 'supported', 'unsupported', 'verify_accepted',
    'verify_rejected', 'settled', 'failed'
  )),
  evidence_digest       TEXT        NOT NULL CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
  observed_at           TIMESTAMPTZ NOT NULL,
  recorded_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  retain_until          TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 years'),
  UNIQUE (tenant_reference_sha256, operation_policy_id, request_digest),
  CHECK (retain_until >= observed_at + interval '7 years')
);

CREATE TABLE x402_cdp_capability_witnesses (
  id                    TEXT        PRIMARY KEY,
  protocol_version      INTEGER     NOT NULL CHECK (protocol_version = 2),
  scheme                TEXT        NOT NULL CHECK (scheme = 'exact'),
  network               TEXT        NOT NULL CHECK (network = 'eip155:84532'),
  asset_contract        TEXT        NOT NULL CHECK (
    lower(asset_contract) = lower('0x036CbD53842c5426634e7929541eC2318f3dCF7e')
  ),
  response_digest       TEXT        NOT NULL CHECK (response_digest ~ '^[0-9a-f]{64}$'),
  supported             BOOLEAN     NOT NULL CHECK (supported),
  captured_at           TIMESTAMPTZ NOT NULL,
  expires_at            TIMESTAMPTZ NOT NULL,
  retain_until          TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 years'),
  CHECK (expires_at > captured_at AND expires_at <= captured_at + interval '15 minutes'),
  CHECK (retain_until >= captured_at + interval '7 years')
);

CREATE TABLE x402_sweep_destination_changes (
  id                    TEXT        PRIMARY KEY,
  environment           TEXT        NOT NULL CHECK (environment IN ('sandbox', 'live')),
  checksummed_address   TEXT        NOT NULL CHECK (checksummed_address ~ '^0x[0-9A-Fa-f]{40}$'),
  manifest_digest       TEXT        NOT NULL CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),
  requested_at          TIMESTAMPTZ NOT NULL,
  treasury_approved_by  TEXT        NOT NULL,
  treasury_approved_at  TIMESTAMPTZ NOT NULL,
  security_approved_by  TEXT        NOT NULL,
  security_approved_at  TIMESTAMPTZ NOT NULL,
  effective_at          TIMESTAMPTZ NOT NULL,
  test_transfer_tx_hash TEXT        NOT NULL CHECK (test_transfer_tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
  confirmation_phrase   TEXT        NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (treasury_approved_by <> security_approved_by),
  CHECK (
    (environment = 'live' AND effective_at >= GREATEST(treasury_approved_at, security_approved_at) + interval '24 hours')
    OR environment = 'sandbox'
  ),
  CHECK (confirmation_phrase = 'APPROVE_X402_SWEEP_DESTINATION_CHANGE_NO_BYPASS')
);

CREATE OR REPLACE FUNCTION enforce_x402_wallet_registry_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     OR OLD.status = 'retired'
     OR NEW.status <> 'retired'
     OR NEW.may_receive
     OR NEW.may_sign
     OR NEW.retired_at IS NULL
     OR ROW(NEW.id, NEW.label, NEW.environment, NEW.network, NEW.address,
            NEW.custody, NEW.hsm_key_versioned_id, NEW.created_at)
        IS DISTINCT FROM
        ROW(OLD.id, OLD.label, OLD.environment, OLD.network, OLD.address,
            OLD.custody, OLD.hsm_key_versioned_id, OLD.created_at) THEN
    RAISE EXCEPTION 'x402 wallet registry permits only one-way retirement'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER x402_wallet_registry_one_way_retirement
BEFORE UPDATE OR DELETE ON x402_seller_wallets
FOR EACH ROW EXECUTE FUNCTION enforce_x402_wallet_registry_transition();
CREATE TRIGGER x402_wallet_registry_no_truncate
BEFORE TRUNCATE ON x402_seller_wallets
FOR EACH STATEMENT EXECUTE FUNCTION reject_x402_seller_immutable_mutation();
CREATE TRIGGER x402_api_key_grants_immutable
BEFORE UPDATE ON x402_api_key_operation_grants
FOR EACH ROW EXECUTE FUNCTION reject_x402_seller_immutable_mutation();
CREATE TRIGGER x402_counterfactual_observations_immutable
BEFORE UPDATE OR DELETE ON x402_counterfactual_observations
FOR EACH ROW EXECUTE FUNCTION reject_x402_seller_immutable_mutation();
CREATE TRIGGER x402_counterfactual_observations_no_truncate
BEFORE TRUNCATE ON x402_counterfactual_observations
FOR EACH STATEMENT EXECUTE FUNCTION reject_x402_seller_immutable_mutation();
CREATE TRIGGER x402_cdp_witnesses_immutable
BEFORE UPDATE OR DELETE ON x402_cdp_capability_witnesses
FOR EACH ROW EXECUTE FUNCTION reject_x402_seller_immutable_mutation();
CREATE TRIGGER x402_cdp_witnesses_no_truncate
BEFORE TRUNCATE ON x402_cdp_capability_witnesses
FOR EACH STATEMENT EXECUTE FUNCTION reject_x402_seller_immutable_mutation();
CREATE TRIGGER x402_destination_changes_immutable
BEFORE UPDATE OR DELETE ON x402_sweep_destination_changes
FOR EACH ROW EXECUTE FUNCTION reject_x402_seller_immutable_mutation();
CREATE TRIGGER x402_destination_changes_no_truncate
BEFORE TRUNCATE ON x402_sweep_destination_changes
FOR EACH STATEMENT EXECUTE FUNCTION reject_x402_seller_immutable_mutation();

ALTER TABLE x402_api_key_operation_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE x402_api_key_operation_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY x402_api_key_operation_grants_tenant ON x402_api_key_operation_grants
  USING (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE x402_counterfactual_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE x402_counterfactual_observations FORCE ROW LEVEL SECURITY;
CREATE POLICY x402_counterfactual_observations_tenant ON x402_counterfactual_observations
  USING (tenant_id = current_setting('app.tenant_id', true));

REVOKE ALL PRIVILEGES ON x402_seller_wallets, x402_api_key_operation_grants,
  x402_counterfactual_observations, x402_cdp_capability_witnesses,
  x402_sweep_destination_changes FROM PUBLIC;

COMMIT;
