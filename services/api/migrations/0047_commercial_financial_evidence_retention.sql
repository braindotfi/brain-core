-- Commercial financial evidence retention.
--
-- Tenant erasure keeps only minimized accounting and settlement evidence for
-- seven years. The retained subject is opaque and HMAC-linked to the former
-- tenant identifier. Runtime roles never receive the HMAC key and never gain
-- direct mutation privileges on retained evidence.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE commercial_retention_hmac_keys (
  version               INTEGER     PRIMARY KEY CHECK (version > 0),
  key_material          BYTEA       NOT NULL CHECK (octet_length(key_material) >= 32),
  active                BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (active)
);

INSERT INTO commercial_retention_hmac_keys (version, key_material)
VALUES (1, gen_random_bytes(32))
ON CONFLICT (version) DO NOTHING;

CREATE TABLE commercial_retention_subjects (
  id                    TEXT        PRIMARY KEY,
  former_tenant_digest  TEXT        NOT NULL UNIQUE CHECK (former_tenant_digest ~ '^[0-9a-f]{64}$'),
  hmac_key_version      INTEGER     NOT NULL REFERENCES commercial_retention_hmac_keys(version),
  billing_account_id    TEXT        REFERENCES commercial_billing_accounts(id) ON DELETE SET NULL,
  retirement_receipt_id TEXT        NOT NULL UNIQUE,
  retired_at            TIMESTAMPTZ NOT NULL,
  retain_until          TIMESTAMPTZ NOT NULL,
  legal_hold            BOOLEAN     NOT NULL DEFAULT FALSE,
  purged_at             TIMESTAMPTZ,
  CHECK (retain_until >= retired_at + interval '7 years'),
  CHECK (purged_at IS NULL OR purged_at >= retired_at)
);

CREATE TABLE commercial_retention_extractor_registry (
  source_table          TEXT        NOT NULL,
  source_kind           TEXT        NOT NULL,
  schema_version        INTEGER     NOT NULL CHECK (schema_version > 0),
  enabled               BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_table, source_kind, schema_version)
);

INSERT INTO commercial_retention_extractor_registry (source_table, source_kind, schema_version)
VALUES
  ('commercial_stripe_subscriptions', 'subscription', 1),
  ('commercial_charge_facts', 'charge_fact', 1),
  ('x402_payment_operations', 'payment_operation', 1),
  ('x402_seller_logical_operations', 'logical_operation', 1),
  ('x402_seller_quotes', 'quote', 1),
  ('x402_seller_nonce_consumptions', 'nonce_consumption', 1),
  ('x402_seller_receipts', 'receipt', 1),
  ('commercial_stripe_events', 'customer.subscription.created', 1),
  ('commercial_stripe_events', 'customer.subscription.updated', 1),
  ('commercial_stripe_events', 'customer.subscription.deleted', 1),
  ('commercial_stripe_events', 'checkout.session.completed', 1),
  ('commercial_stripe_events', 'invoice.created', 1),
  ('commercial_stripe_events', 'invoice.finalized', 1),
  ('commercial_stripe_events', 'invoice.paid', 1),
  ('commercial_stripe_events', 'invoice.payment_failed', 1),
  ('commercial_stripe_events', 'invoice.voided', 1),
  ('commercial_stripe_events', 'invoice.marked_uncollectible', 1),
  ('commercial_stripe_events', 'charge.refunded', 1),
  ('commercial_stripe_events', 'charge.dispute.created', 1),
  ('commercial_stripe_events', 'charge.dispute.closed', 1),
  ('x402_seller_settlement_events', 'verified', 1),
  ('x402_seller_settlement_events', 'rejected', 1),
  ('x402_seller_settlement_events', 'settlement_pending', 1),
  ('x402_seller_settlement_events', 'settled', 1),
  ('x402_seller_settlement_events', 'l2_sealed', 1),
  ('x402_seller_settlement_events', 'l2_reorged', 1),
  ('x402_seller_settlement_events', 'l1_included', 1),
  ('x402_seller_settlement_events', 'l1_failed', 1),
  ('x402_seller_settlement_events', 'fulfilled', 1),
  ('x402_seller_settlement_events', 'service_failed', 1),
  ('x402_seller_settlement_events', 'refund_pending', 1),
  ('x402_seller_settlement_events', 'refunded', 1),
  ('x402_seller_settlement_events', 'reconciled', 1)
ON CONFLICT DO NOTHING;

CREATE TABLE commercial_retirement_seals (
  tenant_id             TEXT        PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  retirement_receipt_id TEXT        NOT NULL UNIQUE,
  sealed_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE commercial_retirement_seals ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_retirement_seals FORCE ROW LEVEL SECURITY;
CREATE POLICY commercial_retirement_seals_tenant_read ON commercial_retirement_seals
  FOR SELECT USING (tenant_id = current_setting('app.tenant_id', true));

CREATE TABLE commercial_retention_receipts (
  id                    TEXT        PRIMARY KEY,
  retention_subject_id  TEXT        NOT NULL UNIQUE REFERENCES commercial_retention_subjects(id),
  source_counts         JSONB       NOT NULL,
  archive_counts        JSONB       NOT NULL,
  source_digests        JSONB       NOT NULL,
  archive_digests       JSONB       NOT NULL,
  extractor_versions    JSONB       NOT NULL,
  prepared_txid         BIGINT      NOT NULL,
  completed_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (source_counts = archive_counts),
  CHECK (source_digests = archive_digests)
);

-- All retained evidence tables share a deliberately small envelope. The JSON
-- object is produced only by the security-definer extractor below. Direct DML
-- is denied to every runtime role.
CREATE TABLE commercial_retained_stripe_subscriptions (
  retention_subject_id TEXT NOT NULL REFERENCES commercial_retention_subjects(id),
  source_table TEXT NOT NULL CHECK (source_table = 'commercial_stripe_subscriptions'),
  source_row_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  evidence JSONB NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  evidence_digest TEXT NOT NULL CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
  occurred_at TIMESTAMPTZ NOT NULL,
  retained_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retain_until TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (source_table, source_row_id),
  CHECK (retain_until >= occurred_at + interval '7 years'),
  CHECK (evidence_digest = encode(digest(evidence::text, 'sha256'), 'hex'))
);

CREATE TABLE commercial_retained_stripe_events (
  retention_subject_id TEXT NOT NULL REFERENCES commercial_retention_subjects(id),
  source_table TEXT NOT NULL CHECK (source_table = 'commercial_stripe_events'),
  source_row_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  evidence JSONB NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  evidence_digest TEXT NOT NULL CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
  occurred_at TIMESTAMPTZ NOT NULL,
  retained_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retain_until TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (source_table, source_row_id),
  CHECK (retain_until >= occurred_at + interval '7 years'),
  CHECK (evidence_digest = encode(digest(evidence::text, 'sha256'), 'hex'))
);

CREATE TABLE commercial_retained_charge_facts (
  retention_subject_id TEXT NOT NULL REFERENCES commercial_retention_subjects(id),
  source_table TEXT NOT NULL CHECK (source_table = 'commercial_charge_facts'),
  source_row_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  evidence JSONB NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  evidence_digest TEXT NOT NULL CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
  occurred_at TIMESTAMPTZ NOT NULL,
  retained_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retain_until TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (source_table, source_row_id),
  CHECK (retain_until >= occurred_at + interval '7 years'),
  CHECK (evidence_digest = encode(digest(evidence::text, 'sha256'), 'hex'))
);

CREATE TABLE commercial_retained_x402_operations (
  retention_subject_id TEXT NOT NULL REFERENCES commercial_retention_subjects(id),
  source_table TEXT NOT NULL CHECK (source_table IN (
    'x402_payment_operations', 'x402_seller_logical_operations',
    'x402_seller_quotes', 'x402_seller_nonce_consumptions', 'x402_seller_receipts'
  )),
  source_row_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  evidence JSONB NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  evidence_digest TEXT NOT NULL CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
  occurred_at TIMESTAMPTZ NOT NULL,
  retained_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retain_until TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (source_table, source_row_id),
  CHECK (retain_until >= occurred_at + interval '7 years'),
  CHECK (evidence_digest = encode(digest(evidence::text, 'sha256'), 'hex'))
);

CREATE TABLE commercial_retained_x402_events (
  retention_subject_id TEXT NOT NULL REFERENCES commercial_retention_subjects(id),
  source_table TEXT NOT NULL CHECK (source_table = 'x402_seller_settlement_events'),
  source_row_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  evidence JSONB NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  evidence_digest TEXT NOT NULL CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
  occurred_at TIMESTAMPTZ NOT NULL,
  retained_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retain_until TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (source_table, source_row_id),
  CHECK (retain_until >= occurred_at + interval '7 years'),
  CHECK (evidence_digest = encode(digest(evidence::text, 'sha256'), 'hex'))
);

CREATE TABLE commercial_retained_provider_commands (
  retention_subject_id TEXT NOT NULL REFERENCES commercial_retention_subjects(id),
  source_table TEXT NOT NULL CHECK (source_table = 'commercial_provider_commands'),
  source_row_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  evidence JSONB NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  evidence_digest TEXT NOT NULL CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
  occurred_at TIMESTAMPTZ NOT NULL,
  retained_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retain_until TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (source_table, source_row_id),
  CHECK (retain_until >= occurred_at + interval '7 years'),
  CHECK (evidence_digest = encode(digest(evidence::text, 'sha256'), 'hex'))
);

CREATE TABLE commercial_retention_legal_hold_events (
  id TEXT PRIMARY KEY,
  retention_subject_id TEXT NOT NULL REFERENCES commercial_retention_subjects(id),
  legal_hold BOOLEAN NOT NULL,
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  actor TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE commercial_retention_purge_receipts (
  id TEXT PRIMARY KEY,
  retention_subject_id TEXT NOT NULL,
  retirement_receipt_id TEXT NOT NULL,
  manifest_digest TEXT NOT NULL CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),
  purged_counts JSONB NOT NULL,
  actor TEXT NOT NULL,
  purged_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION reject_commercial_activity_after_retention_seal()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE activity_tenant_ids TEXT[];
BEGIN
  activity_tenant_ids := ARRAY_REMOVE(ARRAY[
    NEW.tenant_id,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.tenant_id ELSE NULL END
  ], NULL);

  -- Serialize provider writes with retirement's tenant-row lock. A writer
  -- that started first finishes before extraction. A writer that starts after
  -- retirement waits, then observes the seal and fails closed.
  PERFORM 1
    FROM public.tenants
   WHERE id = ANY(activity_tenant_ids)
   ORDER BY id
   FOR KEY SHARE;

  IF EXISTS (
    SELECT 1 FROM public.commercial_retirement_seals
     WHERE tenant_id = ANY(activity_tenant_ids)
  ) THEN
    RAISE EXCEPTION 'commercial provider activity is sealed for tenant'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER commercial_stripe_subscriptions_retention_seal_guard
BEFORE INSERT OR UPDATE ON commercial_stripe_subscriptions FOR EACH ROW
EXECUTE FUNCTION reject_commercial_activity_after_retention_seal();
CREATE TRIGGER commercial_stripe_events_retention_seal_guard
BEFORE INSERT OR UPDATE ON commercial_stripe_events FOR EACH ROW
EXECUTE FUNCTION reject_commercial_activity_after_retention_seal();
CREATE TRIGGER commercial_charge_facts_retention_seal_guard
BEFORE INSERT OR UPDATE ON commercial_charge_facts FOR EACH ROW
EXECUTE FUNCTION reject_commercial_activity_after_retention_seal();
CREATE TRIGGER x402_payment_operations_retention_seal_guard
BEFORE INSERT OR UPDATE ON x402_payment_operations FOR EACH ROW
EXECUTE FUNCTION reject_commercial_activity_after_retention_seal();
CREATE TRIGGER commercial_provider_commands_retention_seal_guard
BEFORE INSERT OR UPDATE ON commercial_provider_commands FOR EACH ROW
EXECUTE FUNCTION reject_commercial_activity_after_retention_seal();
CREATE TRIGGER x402_seller_logical_operations_retention_seal_guard
BEFORE INSERT OR UPDATE ON x402_seller_logical_operations FOR EACH ROW
EXECUTE FUNCTION reject_commercial_activity_after_retention_seal();
CREATE TRIGGER x402_seller_receipts_retention_seal_guard
BEFORE INSERT OR UPDATE ON x402_seller_receipts FOR EACH ROW
EXECUTE FUNCTION reject_commercial_activity_after_retention_seal();

CREATE OR REPLACE FUNCTION reject_x402_seller_child_activity_after_retention_seal()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE activity_tenant_ids TEXT[];
BEGIN
  IF TG_TABLE_NAME = 'x402_seller_quotes' THEN
    SELECT array_agg(DISTINCT operation.tenant_id ORDER BY operation.tenant_id)
      INTO activity_tenant_ids
      FROM public.x402_seller_logical_operations operation
     WHERE operation.id IN (
       NEW.logical_operation_id,
       CASE WHEN TG_OP = 'UPDATE' THEN OLD.logical_operation_id ELSE NULL END
     ) AND operation.tenant_id IS NOT NULL;
  ELSIF TG_TABLE_NAME = 'x402_seller_nonce_consumptions' THEN
    SELECT array_agg(DISTINCT operation.tenant_id ORDER BY operation.tenant_id)
      INTO activity_tenant_ids
      FROM public.x402_seller_quotes quote
      JOIN public.x402_seller_logical_operations operation
        ON operation.id = quote.logical_operation_id
     WHERE quote.id IN (
       NEW.quote_id,
       CASE WHEN TG_OP = 'UPDATE' THEN OLD.quote_id ELSE NULL END
     ) AND operation.tenant_id IS NOT NULL;
  ELSE
    SELECT array_agg(DISTINCT receipt.tenant_id ORDER BY receipt.tenant_id)
      INTO activity_tenant_ids
      FROM public.x402_seller_receipts receipt
     WHERE receipt.id IN (
       NEW.receipt_id,
       CASE WHEN TG_OP = 'UPDATE' THEN OLD.receipt_id ELSE NULL END
     ) AND receipt.tenant_id IS NOT NULL;
  END IF;
  activity_tenant_ids := COALESCE(activity_tenant_ids, ARRAY[]::TEXT[]);
  PERFORM 1
    FROM public.tenants
   WHERE id = ANY(activity_tenant_ids)
   ORDER BY id
   FOR KEY SHARE;
  IF EXISTS (
    SELECT 1 FROM public.commercial_retirement_seals
     WHERE tenant_id = ANY(activity_tenant_ids)
  ) THEN
    RAISE EXCEPTION 'commercial provider activity is sealed for tenant'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER x402_seller_quotes_retention_seal_guard
BEFORE INSERT OR UPDATE ON x402_seller_quotes FOR EACH ROW
EXECUTE FUNCTION reject_x402_seller_child_activity_after_retention_seal();
CREATE TRIGGER x402_seller_nonce_consumptions_retention_seal_guard
BEFORE INSERT OR UPDATE ON x402_seller_nonce_consumptions FOR EACH ROW
EXECUTE FUNCTION reject_x402_seller_child_activity_after_retention_seal();
CREATE TRIGGER x402_seller_settlement_events_retention_seal_guard
BEFORE INSERT OR UPDATE ON x402_seller_settlement_events FOR EACH ROW
EXECUTE FUNCTION reject_x402_seller_child_activity_after_retention_seal();

CREATE OR REPLACE FUNCTION reject_x402_seller_immutable_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.commercial_retention_source_delete', true)
       IS DISTINCT FROM 'authorized' THEN
    RAISE EXCEPTION 'x402 seller evidence is append-only' USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION reject_commercial_retention_evidence_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.commercial_retention_purge', true) IS DISTINCT FROM 'authorized' THEN
    RAISE EXCEPTION 'commercial retained evidence is append-only' USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'commercial_retention_hmac_keys', 'commercial_retention_subjects',
    'commercial_retention_extractor_registry',
    'commercial_retention_receipts', 'commercial_retained_stripe_subscriptions',
    'commercial_retained_stripe_events', 'commercial_retained_charge_facts',
    'commercial_retained_x402_operations', 'commercial_retained_x402_events',
    'commercial_retained_provider_commands', 'commercial_retention_legal_hold_events',
    'commercial_retention_purge_receipts'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_commercial_retention_evidence_mutation()',
      table_name, table_name
    );
    EXECUTE format(
      'CREATE TRIGGER %I_no_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION reject_commercial_retention_evidence_mutation()',
      table_name, table_name
    );
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION commercial_retention_subject_digest(p_tenant_id TEXT)
RETURNS TABLE(digest_hex TEXT, key_version INTEGER)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT encode(hmac(convert_to(p_tenant_id, 'UTF8'), key_material, 'sha256'), 'hex'), version
    FROM public.commercial_retention_hmac_keys
   WHERE active
   ORDER BY version DESC
   LIMIT 1
$$;

CREATE OR REPLACE FUNCTION commercial_retention_extractor_version(
  p_source_table TEXT, p_source_kind TEXT
)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE selected_version INTEGER;
BEGIN
  SELECT schema_version INTO selected_version
    FROM public.commercial_retention_extractor_registry
   WHERE source_table = p_source_table AND source_kind = p_source_kind AND enabled
   ORDER BY schema_version DESC LIMIT 1;
  IF selected_version IS NULL THEN
    RAISE EXCEPTION 'no versioned commercial retention extractor for %.%',
      p_source_table, p_source_kind USING ERRCODE = '55000';
  END IF;
  RETURN selected_version;
END;
$$;

CREATE OR REPLACE FUNCTION commercial_retention_digest_set(
  p_table REGCLASS, p_subject_id TEXT
)
RETURNS TABLE(row_count BIGINT, ordered_digest TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  RETURN QUERY EXECUTE format(
    'SELECT count(*)::bigint, encode(digest(COALESCE(string_agg(evidence_digest, '','' ORDER BY source_table, source_row_id), ''''), ''sha256''), ''hex'') FROM %s WHERE retention_subject_id = $1',
    p_table
  ) USING p_subject_id;
END;
$$;

CREATE OR REPLACE FUNCTION commercial_retention_source_count(
  p_source_name TEXT, p_tenant_id TEXT
)
RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE result_count BIGINT;
BEGIN
  CASE p_source_name
    WHEN 'commercial_stripe_subscriptions' THEN
      SELECT count(*) INTO result_count FROM public.commercial_stripe_subscriptions WHERE tenant_id = p_tenant_id;
    WHEN 'commercial_stripe_events' THEN
      SELECT count(*) INTO result_count FROM public.commercial_stripe_events WHERE tenant_id = p_tenant_id;
    WHEN 'commercial_charge_facts' THEN
      SELECT count(*) INTO result_count FROM public.commercial_charge_facts WHERE tenant_id = p_tenant_id;
    WHEN 'x402_operations' THEN
      SELECT
        (SELECT count(*) FROM public.x402_payment_operations WHERE tenant_id = p_tenant_id)
        + (SELECT count(*) FROM public.x402_seller_logical_operations WHERE tenant_id = p_tenant_id)
        + (SELECT count(*) FROM public.x402_seller_quotes quote
             JOIN public.x402_seller_logical_operations operation
               ON operation.id = quote.logical_operation_id
            WHERE operation.tenant_id = p_tenant_id)
        + (SELECT count(*) FROM public.x402_seller_nonce_consumptions nonce
             JOIN public.x402_seller_quotes quote ON quote.id = nonce.quote_id
             JOIN public.x402_seller_logical_operations operation
               ON operation.id = quote.logical_operation_id
            WHERE operation.tenant_id = p_tenant_id)
        + (SELECT count(*) FROM public.x402_seller_receipts WHERE tenant_id = p_tenant_id)
        INTO result_count;
    WHEN 'x402_events' THEN
      SELECT count(*) INTO result_count
        FROM public.x402_seller_settlement_events event
        JOIN public.x402_seller_receipts receipt ON receipt.id = event.receipt_id
       WHERE receipt.tenant_id = p_tenant_id;
    WHEN 'commercial_provider_commands' THEN
      SELECT count(*) INTO result_count FROM public.commercial_provider_commands WHERE tenant_id = p_tenant_id;
    ELSE
      RAISE EXCEPTION 'unknown commercial retention source manifest %', p_source_name;
  END CASE;
  RETURN result_count;
END;
$$;

CREATE OR REPLACE FUNCTION prepare_commercial_financial_retention(
  p_tenant_id TEXT, p_retirement_receipt_id TEXT
)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  digest_row RECORD;
  subject_id TEXT;
  billing_id TEXT;
  retain_through TIMESTAMPTZ := now() + interval '7 years';
  counts JSONB := '{}'::jsonb;
  archive_counts JSONB := '{}'::jsonb;
  digests JSONB := '{}'::jsonb;
  versions JSONB := '{}'::jsonb;
  item RECORD;
  archive_stat RECORD;
BEGIN
  IF p_tenant_id IS NULL OR p_retirement_receipt_id IS NULL THEN
    RAISE EXCEPTION 'tenant and retirement receipt are required' USING ERRCODE = '22004';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('commercial-retention:' || p_tenant_id, 0));
  PERFORM 1 FROM public.tenants WHERE id = p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tenant not found' USING ERRCODE = 'P0002'; END IF;

  -- Lock every operational source set after taking the tenant lock. Provider
  -- writers take a compatible tenant-row lock in the seal guard, so no source
  -- row can appear or change between these locks and receipt verification.
  PERFORM 1 FROM public.commercial_billing_account_tenants WHERE tenant_id = p_tenant_id FOR UPDATE;
  PERFORM 1 FROM public.commercial_stripe_subscriptions WHERE tenant_id = p_tenant_id FOR UPDATE;
  PERFORM 1 FROM public.commercial_stripe_events WHERE tenant_id = p_tenant_id FOR UPDATE;
  PERFORM 1 FROM public.commercial_charge_facts WHERE tenant_id = p_tenant_id FOR UPDATE;
  PERFORM 1 FROM public.x402_payment_operations WHERE tenant_id = p_tenant_id FOR UPDATE;
  PERFORM 1 FROM public.commercial_provider_commands WHERE tenant_id = p_tenant_id FOR UPDATE;
  PERFORM 1 FROM public.x402_seller_logical_operations WHERE tenant_id = p_tenant_id FOR UPDATE;
  PERFORM 1
    FROM public.x402_seller_quotes quote
    JOIN public.x402_seller_logical_operations operation
      ON operation.id = quote.logical_operation_id
   WHERE operation.tenant_id = p_tenant_id
   FOR UPDATE OF quote;
  PERFORM 1
    FROM public.x402_seller_nonce_consumptions nonce
    JOIN public.x402_seller_quotes quote ON quote.id = nonce.quote_id
    JOIN public.x402_seller_logical_operations operation
      ON operation.id = quote.logical_operation_id
   WHERE operation.tenant_id = p_tenant_id
   FOR UPDATE OF nonce;
  PERFORM 1 FROM public.x402_seller_receipts WHERE tenant_id = p_tenant_id FOR UPDATE;
  PERFORM 1
    FROM public.x402_seller_settlement_events event
    JOIN public.x402_seller_receipts receipt ON receipt.id = event.receipt_id
   WHERE receipt.tenant_id = p_tenant_id
   FOR UPDATE OF event;

  SELECT * INTO digest_row FROM public.commercial_retention_subject_digest(p_tenant_id);
  IF digest_row.digest_hex IS NULL THEN
    RAISE EXCEPTION 'commercial retention HMAC key is unavailable' USING ERRCODE = '55000';
  END IF;
  SELECT id INTO subject_id FROM public.commercial_retention_subjects
   WHERE former_tenant_digest = digest_row.digest_hex;
  IF subject_id IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM public.commercial_retention_subjects
       WHERE id = subject_id AND retirement_receipt_id <> p_retirement_receipt_id
    ) THEN
      RAISE EXCEPTION 'tenant retention was prepared under a different receipt' USING ERRCODE = '55000';
    END IF;
    RETURN subject_id;
  END IF;

  IF EXISTS (SELECT 1 FROM public.commercial_provider_commands WHERE tenant_id = p_tenant_id AND status IN ('pending', 'dispatched'))
     OR EXISTS (SELECT 1 FROM public.commercial_stripe_events WHERE tenant_id = p_tenant_id AND status IN ('received', 'failed'))
     OR EXISTS (SELECT 1 FROM public.commercial_stripe_subscriptions WHERE tenant_id = p_tenant_id AND status <> 'canceled')
     OR EXISTS (SELECT 1 FROM public.commercial_charge_facts WHERE tenant_id = p_tenant_id AND status IN ('provisional', 'disputed'))
     OR EXISTS (SELECT 1 FROM public.x402_payment_operations WHERE tenant_id = p_tenant_id AND (facilitator_status = 'verified' OR fulfillment_status = 'pending'))
     OR EXISTS (SELECT 1 FROM public.x402_seller_logical_operations WHERE tenant_id = p_tenant_id AND state NOT IN ('fulfilled', 'refunded'))
     OR EXISTS (SELECT 1 FROM public.x402_seller_receipts WHERE tenant_id = p_tenant_id AND state NOT IN ('fulfilled', 'refunded', 'rejected')) THEN
    RAISE EXCEPTION 'commercial provider work is unsettled' USING ERRCODE = '55000';
  END IF;

  SELECT GREATEST(
    retain_through,
    COALESCE((SELECT max(GREATEST(
      created_at,
      COALESCE(updated_at, created_at),
      COALESCE(last_event_created_at, created_at)
    )) + interval '7 years' FROM public.commercial_stripe_subscriptions WHERE tenant_id = p_tenant_id), '-infinity'),
    COALESCE((SELECT max(GREATEST(
      event_created_at,
      received_at,
      COALESCE(applied_at, received_at)
    )) + interval '7 years' FROM public.commercial_stripe_events WHERE tenant_id = p_tenant_id), '-infinity'),
    COALESCE((SELECT max(GREATEST(
      created_at,
      COALESCE(finalized_at, created_at)
    )) + interval '7 years' FROM public.commercial_charge_facts WHERE tenant_id = p_tenant_id), '-infinity'),
    COALESCE((SELECT max(GREATEST(
      created_at,
      COALESCE(verified_at, created_at),
      COALESCE(settled_at, created_at),
      COALESCE(fulfilled_at, created_at),
      COALESCE(reconciled_at, created_at)
    )) + interval '7 years' FROM public.x402_payment_operations WHERE tenant_id = p_tenant_id), '-infinity'),
    COALESCE((SELECT max(GREATEST(created_at, updated_at)) + interval '7 years'
      FROM public.commercial_provider_commands WHERE tenant_id = p_tenant_id), '-infinity'),
    COALESCE((SELECT max(retain_until) FROM public.x402_seller_logical_operations
      WHERE tenant_id = p_tenant_id), '-infinity'),
    COALESCE((SELECT max(quote.retain_until)
      FROM public.x402_seller_quotes quote
      JOIN public.x402_seller_logical_operations operation
        ON operation.id = quote.logical_operation_id
      WHERE operation.tenant_id = p_tenant_id), '-infinity'),
    COALESCE((SELECT max(nonce.retain_until)
      FROM public.x402_seller_nonce_consumptions nonce
      JOIN public.x402_seller_quotes quote ON quote.id = nonce.quote_id
      JOIN public.x402_seller_logical_operations operation
        ON operation.id = quote.logical_operation_id
      WHERE operation.tenant_id = p_tenant_id), '-infinity'),
    COALESCE((SELECT max(retain_until) FROM public.x402_seller_receipts
      WHERE tenant_id = p_tenant_id), '-infinity'),
    COALESCE((SELECT max(event.retain_until)
      FROM public.x402_seller_settlement_events event
      JOIN public.x402_seller_receipts receipt ON receipt.id = event.receipt_id
      WHERE receipt.tenant_id = p_tenant_id), '-infinity')
  ) INTO retain_through;

  FOR item IN SELECT DISTINCT event_type AS kind FROM public.commercial_stripe_events WHERE tenant_id = p_tenant_id LOOP
    versions := versions || jsonb_build_object(
      'commercial_stripe_events:' || item.kind,
      public.commercial_retention_extractor_version('commercial_stripe_events', item.kind)
    );
  END LOOP;
  FOR item IN
    SELECT DISTINCT event_kind AS kind
      FROM public.x402_seller_settlement_events event
      JOIN public.x402_seller_receipts receipt ON receipt.id = event.receipt_id
     WHERE receipt.tenant_id = p_tenant_id
  LOOP
    versions := versions || jsonb_build_object(
      'x402_seller_settlement_events:' || item.kind,
      public.commercial_retention_extractor_version('x402_seller_settlement_events', item.kind)
    );
  END LOOP;
  FOR item IN
    SELECT DISTINCT provider || ':' || command_type AS kind
      FROM public.commercial_provider_commands
     WHERE tenant_id = p_tenant_id
  LOOP
    versions := versions || jsonb_build_object(
      'commercial_provider_commands:' || item.kind,
      public.commercial_retention_extractor_version('commercial_provider_commands', item.kind)
    );
  END LOOP;
  versions := versions || jsonb_build_object(
    'commercial_stripe_subscriptions', public.commercial_retention_extractor_version('commercial_stripe_subscriptions', 'subscription'),
    'commercial_charge_facts', public.commercial_retention_extractor_version('commercial_charge_facts', 'charge_fact'),
    'x402_payment_operations', public.commercial_retention_extractor_version('x402_payment_operations', 'payment_operation'),
    'x402_seller_logical_operations', public.commercial_retention_extractor_version('x402_seller_logical_operations', 'logical_operation'),
    'x402_seller_quotes', public.commercial_retention_extractor_version('x402_seller_quotes', 'quote'),
    'x402_seller_nonce_consumptions', public.commercial_retention_extractor_version('x402_seller_nonce_consumptions', 'nonce_consumption'),
    'x402_seller_receipts', public.commercial_retention_extractor_version('x402_seller_receipts', 'receipt')
  );

  SELECT billing_account_id INTO billing_id
    FROM public.commercial_billing_account_tenants
   WHERE tenant_id = p_tenant_id ORDER BY created_at LIMIT 1;
  subject_id := 'retsub_' || encode(gen_random_bytes(16), 'hex');
  INSERT INTO public.commercial_retention_subjects (
    id, former_tenant_digest, hmac_key_version, billing_account_id,
    retirement_receipt_id, retired_at, retain_until
  ) VALUES (
    subject_id, digest_row.digest_hex, digest_row.key_version, billing_id,
    p_retirement_receipt_id, now(), retain_through
  );
  INSERT INTO public.commercial_retirement_seals (tenant_id, retirement_receipt_id)
  VALUES (p_tenant_id, p_retirement_receipt_id);

  INSERT INTO public.commercial_retained_stripe_subscriptions
  SELECT subject_id, 'commercial_stripe_subscriptions', source.id, 1, minimized.evidence,
         encode(digest(minimized.evidence::text, 'sha256'), 'hex'), source.created_at,
         now(), GREATEST(retain_through, source.created_at + interval '7 years')
    FROM public.commercial_stripe_subscriptions source
    CROSS JOIN LATERAL (SELECT jsonb_strip_nulls(jsonb_build_object(
      'billing_account_id', source.billing_account_id, 'catalog_revision_id', source.catalog_revision_id,
      'price_revision_id', source.price_revision_id, 'provider_mode', source.provider_mode,
      'stripe_customer_id', source.stripe_customer_id,
      'stripe_subscription_id', source.stripe_subscription_id,
      'stripe_subscription_item_id', source.stripe_subscription_item_id,
      'status', source.status, 'current_period_start', source.current_period_start,
      'current_period_end', source.current_period_end, 'provider_version', source.provider_version,
      'last_event_id', source.last_event_id, 'last_event_created_at', source.last_event_created_at
    )) AS evidence) minimized WHERE source.tenant_id = p_tenant_id;

  INSERT INTO public.commercial_retained_stripe_events
  SELECT subject_id, 'commercial_stripe_events', source.id,
         public.commercial_retention_extractor_version('commercial_stripe_events', source.event_type),
         minimized.evidence, encode(digest(minimized.evidence::text, 'sha256'), 'hex'), source.event_created_at,
         now(), GREATEST(retain_through, source.event_created_at + interval '7 years')
    FROM public.commercial_stripe_events source
    CROSS JOIN LATERAL (SELECT jsonb_strip_nulls(jsonb_build_object(
      'billing_account_id', source.billing_account_id, 'provider_mode', source.provider_mode,
      'stripe_event_id', source.stripe_event_id, 'event_type', source.event_type,
      'event_created_at', source.event_created_at, 'status', source.status,
      'failure_code', source.failure_code, 'object_id', source.payload #>> '{data,object,id}',
      'currency', source.payload #>> '{data,object,currency}',
      'amount_due', source.payload #>> '{data,object,amount_due}',
      'amount_paid', source.payload #>> '{data,object,amount_paid}',
      'subtotal', source.payload #>> '{data,object,subtotal}',
      'total', source.payload #>> '{data,object,total}'
    )) AS evidence) minimized WHERE source.tenant_id = p_tenant_id;

  INSERT INTO public.commercial_retained_charge_facts
  SELECT subject_id, 'commercial_charge_facts', source.id, 1, minimized.evidence,
         encode(digest(minimized.evidence::text, 'sha256'), 'hex'), source.created_at,
         now(), GREATEST(retain_through, source.created_at + interval '7 years')
    FROM public.commercial_charge_facts source
    CROSS JOIN LATERAL (SELECT jsonb_strip_nulls(jsonb_build_object(
      'billing_account_id', source.billing_account_id, 'charge_kind', source.charge_kind,
      'fee_policy_id', source.fee_policy_id, 'source_reference_sha256', encode(digest(source.source_reference, 'sha256'), 'hex'),
      'source_evidence_sha256', encode(digest(source.source_evidence::text, 'sha256'), 'hex'),
      'basis_amount_minor_units', source.basis_amount_minor_units,
      'fee_amount_minor_units', source.fee_amount_minor_units, 'currency', source.currency,
      'status', source.status, 'finalizes_at', source.finalizes_at,
      'finalized_at', source.finalized_at
    )) AS evidence) minimized WHERE source.tenant_id = p_tenant_id;

  INSERT INTO public.commercial_retained_x402_operations
  SELECT subject_id, 'x402_payment_operations', source.id, 1, minimized.evidence,
         encode(digest(minimized.evidence::text, 'sha256'), 'hex'), source.created_at,
         now(), GREATEST(retain_through, source.created_at + interval '7 years')
    FROM public.x402_payment_operations source
    CROSS JOIN LATERAL (SELECT jsonb_strip_nulls(jsonb_build_object(
      'environment', source.environment, 'operation_class', source.operation_class,
      'operation_id', source.operation_id, 'logical_operation_id', source.logical_operation_id,
      'price_policy_id', source.price_policy_id, 'quote_digest', source.quote_digest,
      'payment_payload_digest', source.payment_payload_digest, 'network', source.network,
      'asset_contract', source.asset_contract, 'recipient_address', source.recipient_address,
      'amount_atomic', source.amount_atomic, 'facilitator_status', source.facilitator_status,
      'settlement_tx_hash', source.settlement_tx_hash, 'l2_inclusion_status', source.l2_inclusion_status,
      'l1_inclusion_status', source.l1_inclusion_status, 'fulfillment_status', source.fulfillment_status,
      'response_digest', source.response_digest, 'refund_tx_hash', source.refund_tx_hash
    )) AS evidence) minimized WHERE source.tenant_id = p_tenant_id;

  INSERT INTO public.commercial_retained_x402_operations
  SELECT subject_id, 'x402_seller_logical_operations', source.id, 1, minimized.evidence,
         encode(digest(minimized.evidence::text, 'sha256'), 'hex'), source.created_at,
         now(), GREATEST(retain_through, source.retain_until)
    FROM public.x402_seller_logical_operations source
    CROSS JOIN LATERAL (SELECT jsonb_strip_nulls(jsonb_build_object(
      'tenant_reference_sha256', source.tenant_reference_sha256,
      'operation_policy_id', source.operation_policy_id, 'environment', source.environment,
      'request_digest', source.request_digest, 'state', source.state
    )) AS evidence) minimized WHERE source.tenant_id = p_tenant_id;

  INSERT INTO public.commercial_retained_x402_operations
  SELECT subject_id, 'x402_seller_quotes', source.id, 1, minimized.evidence,
         encode(digest(minimized.evidence::text, 'sha256'), 'hex'), source.quoted_at,
         now(), GREATEST(retain_through, source.retain_until)
    FROM public.x402_seller_quotes source
    JOIN public.x402_seller_logical_operations operation
      ON operation.id = source.logical_operation_id
    CROSS JOIN LATERAL (SELECT jsonb_strip_nulls(jsonb_build_object(
      'logical_operation_id', source.logical_operation_id,
      'price_policy_id', source.price_policy_id, 'quote_digest', source.quote_digest,
      'nonce_digest', source.nonce_digest, 'protocol_version', source.protocol_version,
      'scheme', source.scheme, 'network', source.network,
      'asset_contract', source.asset_contract, 'recipient_address', source.recipient_address,
      'amount_atomic', source.amount_atomic, 'quoted_at', source.quoted_at,
      'expires_at', source.expires_at
    )) AS evidence) minimized WHERE operation.tenant_id = p_tenant_id;

  INSERT INTO public.commercial_retained_x402_operations
  SELECT subject_id, 'x402_seller_nonce_consumptions', source.nonce_digest, 1,
         minimized.evidence, encode(digest(minimized.evidence::text, 'sha256'), 'hex'),
         source.consumed_at, now(), GREATEST(retain_through, source.retain_until)
    FROM public.x402_seller_nonce_consumptions source
    JOIN public.x402_seller_quotes quote ON quote.id = source.quote_id
    JOIN public.x402_seller_logical_operations operation
      ON operation.id = quote.logical_operation_id
    CROSS JOIN LATERAL (SELECT jsonb_strip_nulls(jsonb_build_object(
      'nonce_digest', source.nonce_digest, 'quote_id', source.quote_id,
      'payment_payload_digest', source.payment_payload_digest,
      'consumed_at', source.consumed_at
    )) AS evidence) minimized WHERE operation.tenant_id = p_tenant_id;

  INSERT INTO public.commercial_retained_x402_operations
  SELECT subject_id, 'x402_seller_receipts', source.id, 1, minimized.evidence,
         encode(digest(minimized.evidence::text, 'sha256'), 'hex'), source.created_at,
         now(), GREATEST(retain_through, source.retain_until)
    FROM public.x402_seller_receipts source
    CROSS JOIN LATERAL (SELECT jsonb_strip_nulls(jsonb_build_object(
      'tenant_reference_sha256', source.tenant_reference_sha256,
      'logical_operation_id', source.logical_operation_id, 'quote_id', source.quote_id,
      'payment_payload_digest', source.payment_payload_digest, 'state', source.state,
      'settlement_tx_hash', source.settlement_tx_hash, 'refund_tx_hash', source.refund_tx_hash,
      'l2_finality', source.l2_finality, 'l1_finality', source.l1_finality, 'version', source.version
    )) AS evidence) minimized WHERE source.tenant_id = p_tenant_id;

  INSERT INTO public.commercial_retained_x402_events
  SELECT subject_id, 'x402_seller_settlement_events', event.id,
         public.commercial_retention_extractor_version('x402_seller_settlement_events', event.event_kind),
         minimized.evidence, encode(digest(minimized.evidence::text, 'sha256'), 'hex'), event.occurred_at,
         now(), GREATEST(retain_through, event.retain_until)
    FROM public.x402_seller_settlement_events event
    JOIN public.x402_seller_receipts receipt ON receipt.id = event.receipt_id
    CROSS JOIN LATERAL (SELECT jsonb_strip_nulls(jsonb_build_object(
      'receipt_id', event.receipt_id, 'sequence', event.sequence, 'event_kind', event.event_kind,
      'facilitator_request_id', event.facilitator_request_id,
      'transaction_hash', event.transaction_hash, 'provider_evidence_digest', event.evidence_digest
    )) AS evidence) minimized WHERE receipt.tenant_id = p_tenant_id;

  INSERT INTO public.commercial_retained_provider_commands
  SELECT subject_id, 'commercial_provider_commands', source.id,
         public.commercial_retention_extractor_version(
           'commercial_provider_commands', source.provider || ':' || source.command_type
         ), minimized.evidence,
         encode(digest(minimized.evidence::text, 'sha256'), 'hex'), source.created_at,
         now(), GREATEST(retain_through, source.created_at + interval '7 years')
    FROM public.commercial_provider_commands source
    CROSS JOIN LATERAL (SELECT jsonb_strip_nulls(jsonb_build_object(
      'billing_account_id', source.billing_account_id, 'provider', source.provider,
      'provider_mode', source.provider_mode, 'command_type', source.command_type,
      'idempotency_key_sha256', encode(digest(source.idempotency_key, 'sha256'), 'hex'),
      'request_envelope_sha256', encode(digest(source.request_envelope::text, 'sha256'), 'hex'),
      'status', source.status, 'attempt_count', source.attempt_count,
      'provider_reference', source.provider_reference, 'failure_code', source.failure_code,
      'updated_at', source.updated_at
    )) AS evidence) minimized WHERE source.tenant_id = p_tenant_id;

  IF EXISTS (
    (SELECT id FROM public.commercial_stripe_subscriptions WHERE tenant_id = p_tenant_id
     EXCEPT SELECT source_row_id FROM public.commercial_retained_stripe_subscriptions WHERE retention_subject_id = subject_id)
    UNION ALL
    (SELECT source_row_id FROM public.commercial_retained_stripe_subscriptions WHERE retention_subject_id = subject_id
     EXCEPT SELECT id FROM public.commercial_stripe_subscriptions WHERE tenant_id = p_tenant_id)
  ) OR EXISTS (
    (SELECT id FROM public.commercial_stripe_events WHERE tenant_id = p_tenant_id
     EXCEPT SELECT source_row_id FROM public.commercial_retained_stripe_events WHERE retention_subject_id = subject_id)
    UNION ALL
    (SELECT source_row_id FROM public.commercial_retained_stripe_events WHERE retention_subject_id = subject_id
     EXCEPT SELECT id FROM public.commercial_stripe_events WHERE tenant_id = p_tenant_id)
  ) OR EXISTS (
    (SELECT id FROM public.commercial_charge_facts WHERE tenant_id = p_tenant_id
     EXCEPT SELECT source_row_id FROM public.commercial_retained_charge_facts WHERE retention_subject_id = subject_id)
    UNION ALL
    (SELECT source_row_id FROM public.commercial_retained_charge_facts WHERE retention_subject_id = subject_id
     EXCEPT SELECT id FROM public.commercial_charge_facts WHERE tenant_id = p_tenant_id)
  ) OR EXISTS (
    (SELECT source_table, source_row_id FROM (
       SELECT 'x402_payment_operations'::text AS source_table, id AS source_row_id
         FROM public.x402_payment_operations WHERE tenant_id = p_tenant_id
       UNION ALL
       SELECT 'x402_seller_logical_operations', id
         FROM public.x402_seller_logical_operations WHERE tenant_id = p_tenant_id
       UNION ALL
       SELECT 'x402_seller_quotes', quote.id
         FROM public.x402_seller_quotes quote
         JOIN public.x402_seller_logical_operations operation
           ON operation.id = quote.logical_operation_id
        WHERE operation.tenant_id = p_tenant_id
       UNION ALL
       SELECT 'x402_seller_nonce_consumptions', nonce.nonce_digest
         FROM public.x402_seller_nonce_consumptions nonce
         JOIN public.x402_seller_quotes quote ON quote.id = nonce.quote_id
         JOIN public.x402_seller_logical_operations operation
           ON operation.id = quote.logical_operation_id
        WHERE operation.tenant_id = p_tenant_id
       UNION ALL
       SELECT 'x402_seller_receipts', id
         FROM public.x402_seller_receipts WHERE tenant_id = p_tenant_id
     ) source_operations
     EXCEPT SELECT source_table, source_row_id FROM public.commercial_retained_x402_operations WHERE retention_subject_id = subject_id)
    UNION ALL
    (SELECT source_table, source_row_id FROM public.commercial_retained_x402_operations WHERE retention_subject_id = subject_id
     EXCEPT SELECT source_table, source_row_id FROM (
       SELECT 'x402_payment_operations'::text AS source_table, id AS source_row_id
         FROM public.x402_payment_operations WHERE tenant_id = p_tenant_id
       UNION ALL
       SELECT 'x402_seller_logical_operations', id
         FROM public.x402_seller_logical_operations WHERE tenant_id = p_tenant_id
       UNION ALL
       SELECT 'x402_seller_quotes', quote.id
         FROM public.x402_seller_quotes quote
         JOIN public.x402_seller_logical_operations operation
           ON operation.id = quote.logical_operation_id
        WHERE operation.tenant_id = p_tenant_id
       UNION ALL
       SELECT 'x402_seller_nonce_consumptions', nonce.nonce_digest
         FROM public.x402_seller_nonce_consumptions nonce
         JOIN public.x402_seller_quotes quote ON quote.id = nonce.quote_id
         JOIN public.x402_seller_logical_operations operation
           ON operation.id = quote.logical_operation_id
        WHERE operation.tenant_id = p_tenant_id
       UNION ALL
       SELECT 'x402_seller_receipts', id
         FROM public.x402_seller_receipts WHERE tenant_id = p_tenant_id
     ) source_operations)
  ) OR EXISTS (
    (SELECT event.id FROM public.x402_seller_settlement_events event
       JOIN public.x402_seller_receipts receipt ON receipt.id = event.receipt_id
      WHERE receipt.tenant_id = p_tenant_id
     EXCEPT SELECT source_row_id FROM public.commercial_retained_x402_events WHERE retention_subject_id = subject_id)
    UNION ALL
    (SELECT source_row_id FROM public.commercial_retained_x402_events WHERE retention_subject_id = subject_id
     EXCEPT SELECT event.id FROM public.x402_seller_settlement_events event
       JOIN public.x402_seller_receipts receipt ON receipt.id = event.receipt_id
      WHERE receipt.tenant_id = p_tenant_id)
  ) OR EXISTS (
    (SELECT id FROM public.commercial_provider_commands WHERE tenant_id = p_tenant_id
     EXCEPT SELECT source_row_id FROM public.commercial_retained_provider_commands WHERE retention_subject_id = subject_id)
    UNION ALL
    (SELECT source_row_id FROM public.commercial_retained_provider_commands WHERE retention_subject_id = subject_id
     EXCEPT SELECT id FROM public.commercial_provider_commands WHERE tenant_id = p_tenant_id)
  ) THEN
    RAISE EXCEPTION 'commercial retention source/archive identity mismatch'
      USING ERRCODE = '55000';
  END IF;

  FOR item IN
    SELECT * FROM (VALUES
      ('commercial_stripe_subscriptions', 'commercial_retained_stripe_subscriptions'::regclass),
      ('commercial_stripe_events', 'commercial_retained_stripe_events'::regclass),
      ('commercial_charge_facts', 'commercial_retained_charge_facts'::regclass),
      ('x402_operations', 'commercial_retained_x402_operations'::regclass),
      ('x402_events', 'commercial_retained_x402_events'::regclass),
      ('commercial_provider_commands', 'commercial_retained_provider_commands'::regclass)
    ) AS manifest(source_name, archive_table)
  LOOP
    SELECT * INTO archive_stat FROM public.commercial_retention_digest_set(item.archive_table, subject_id);
    counts := counts || jsonb_build_object(
      item.source_name,
      public.commercial_retention_source_count(item.source_name, p_tenant_id)
    );
    archive_counts := archive_counts || jsonb_build_object(item.source_name, archive_stat.row_count);
    digests := digests || jsonb_build_object(item.source_name, archive_stat.ordered_digest);
  END LOOP;
  IF counts <> archive_counts THEN
    RAISE EXCEPTION 'commercial retention source/archive count mismatch: % <> %',
      counts, archive_counts USING ERRCODE = '55000';
  END IF;

  -- Each source row maps to exactly one archive row. Digesting the produced
  -- archive is authoritative because the source envelopes are built in the
  -- same statement and never materialize outside this function.
  INSERT INTO public.commercial_retention_receipts (
    id, retention_subject_id, source_counts, archive_counts,
    source_digests, archive_digests, extractor_versions, prepared_txid
  ) VALUES (
    p_retirement_receipt_id, subject_id, counts, archive_counts, digests, digests,
    versions, txid_current()
  );

  -- Seller protocol rows lack a simple tenant predicate on their child
  -- tables. Remove the dependency graph here, after the receipt is durable in
  -- this transaction, so unrestricted operational evidence cannot survive
  -- tenant retirement beside the minimized archive.
  PERFORM set_config('app.commercial_retention_source_delete', 'authorized', true);
  DELETE FROM public.x402_seller_settlement_events event
   USING public.x402_seller_receipts receipt
   WHERE event.receipt_id = receipt.id AND receipt.tenant_id = p_tenant_id;
  DELETE FROM public.x402_seller_nonce_consumptions nonce
   USING public.x402_seller_quotes quote,
         public.x402_seller_logical_operations operation
   WHERE nonce.quote_id = quote.id
     AND quote.logical_operation_id = operation.id
     AND operation.tenant_id = p_tenant_id;
  DELETE FROM public.x402_seller_receipts WHERE tenant_id = p_tenant_id;
  DELETE FROM public.x402_seller_quotes quote
   USING public.x402_seller_logical_operations operation
   WHERE quote.logical_operation_id = operation.id
     AND operation.tenant_id = p_tenant_id;
  DELETE FROM public.x402_seller_logical_operations WHERE tenant_id = p_tenant_id;

  IF billing_id IS NOT NULL THEN
    UPDATE public.commercial_billing_accounts
       SET status = 'closed', final_tenant_unlinked_at = COALESCE(final_tenant_unlinked_at, now()),
           retain_until = GREATEST(COALESCE(retain_until, '-infinity'::timestamptz), retain_through),
           retention_reason = 'accounting_and_settlement_evidence', version = version + 1,
           updated_at = now()
     WHERE id = billing_id;
    DELETE FROM public.commercial_billing_account_tenants
     WHERE tenant_id = p_tenant_id;
  END IF;
  RETURN subject_id;
END;
$$;

CREATE OR REPLACE FUNCTION require_commercial_retention_before_tenant_delete()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE digest_row RECORD;
BEGIN
  IF NOT (
    EXISTS (SELECT 1 FROM public.commercial_retirement_seals WHERE tenant_id = OLD.id)
    OR EXISTS (SELECT 1 FROM public.commercial_billing_account_tenants WHERE tenant_id = OLD.id)
    OR EXISTS (SELECT 1 FROM public.commercial_stripe_subscriptions WHERE tenant_id = OLD.id)
    OR EXISTS (SELECT 1 FROM public.commercial_stripe_events WHERE tenant_id = OLD.id)
    OR EXISTS (SELECT 1 FROM public.commercial_charge_facts WHERE tenant_id = OLD.id)
    OR EXISTS (SELECT 1 FROM public.x402_payment_operations WHERE tenant_id = OLD.id)
    OR EXISTS (SELECT 1 FROM public.x402_seller_logical_operations WHERE tenant_id = OLD.id)
    OR EXISTS (SELECT 1 FROM public.x402_seller_receipts WHERE tenant_id = OLD.id)
    OR EXISTS (SELECT 1 FROM public.commercial_provider_commands WHERE tenant_id = OLD.id)
  ) THEN
    RETURN OLD;
  END IF;
  SELECT * INTO digest_row FROM public.commercial_retention_subject_digest(OLD.id);
  IF NOT EXISTS (
    SELECT 1 FROM public.commercial_retention_subjects subject
    JOIN public.commercial_retention_receipts receipt
      ON receipt.id = subject.retirement_receipt_id
   WHERE subject.former_tenant_digest = digest_row.digest_hex
     AND receipt.prepared_txid = txid_current()
     AND receipt.source_counts = receipt.archive_counts
     AND receipt.source_digests = receipt.archive_digests
  ) THEN
    RAISE EXCEPTION 'successful commercial retention receipt required in tenant deletion transaction'
      USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER tenants_require_commercial_retention
BEFORE DELETE ON tenants FOR EACH ROW
EXECUTE FUNCTION require_commercial_retention_before_tenant_delete();

CREATE OR REPLACE FUNCTION require_commercial_retention_before_source_delete()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE source_tenant_id TEXT;
BEGIN
  source_tenant_id := OLD.tenant_id;
  IF source_tenant_id IS NULL THEN RETURN OLD; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.commercial_retirement_seals seal
    JOIN public.commercial_retention_receipts receipt
      ON receipt.id = seal.retirement_receipt_id
   WHERE seal.tenant_id = source_tenant_id
     AND receipt.prepared_txid = txid_current()
     AND receipt.source_counts = receipt.archive_counts
     AND receipt.source_digests = receipt.archive_digests
  ) THEN
    RAISE EXCEPTION 'commercial source deletion requires a verified retention seal'
      USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER commercial_stripe_subscriptions_retention_delete_guard
BEFORE DELETE ON commercial_stripe_subscriptions FOR EACH ROW
EXECUTE FUNCTION require_commercial_retention_before_source_delete();
CREATE TRIGGER commercial_stripe_events_retention_delete_guard
BEFORE DELETE ON commercial_stripe_events FOR EACH ROW
EXECUTE FUNCTION require_commercial_retention_before_source_delete();
CREATE TRIGGER commercial_charge_facts_retention_delete_guard
BEFORE DELETE ON commercial_charge_facts FOR EACH ROW
EXECUTE FUNCTION require_commercial_retention_before_source_delete();
CREATE TRIGGER x402_payment_operations_retention_delete_guard
BEFORE DELETE ON x402_payment_operations FOR EACH ROW
EXECUTE FUNCTION require_commercial_retention_before_source_delete();
CREATE TRIGGER commercial_provider_commands_retention_delete_guard
BEFORE DELETE ON commercial_provider_commands FOR EACH ROW
EXECUTE FUNCTION require_commercial_retention_before_source_delete();

CREATE OR REPLACE FUNCTION require_commercial_retention_before_x402_seller_delete()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE source_tenant_id TEXT;
BEGIN
  IF TG_TABLE_NAME = 'x402_seller_logical_operations' THEN
    source_tenant_id := OLD.tenant_id;
  ELSIF TG_TABLE_NAME = 'x402_seller_receipts' THEN
    source_tenant_id := OLD.tenant_id;
  ELSIF TG_TABLE_NAME = 'x402_seller_quotes' THEN
    SELECT tenant_id INTO source_tenant_id
      FROM public.x402_seller_logical_operations
     WHERE id = OLD.logical_operation_id;
  ELSIF TG_TABLE_NAME = 'x402_seller_nonce_consumptions' THEN
    SELECT operation.tenant_id INTO source_tenant_id
      FROM public.x402_seller_quotes quote
      JOIN public.x402_seller_logical_operations operation
        ON operation.id = quote.logical_operation_id
     WHERE quote.id = OLD.quote_id;
  ELSE
    SELECT tenant_id INTO source_tenant_id
      FROM public.x402_seller_receipts
     WHERE id = OLD.receipt_id;
  END IF;
  IF source_tenant_id IS NULL THEN RETURN OLD; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.commercial_retirement_seals seal
    JOIN public.commercial_retention_receipts receipt
      ON receipt.id = seal.retirement_receipt_id
   WHERE seal.tenant_id = source_tenant_id
     AND receipt.prepared_txid = txid_current()
     AND receipt.source_counts = receipt.archive_counts
     AND receipt.source_digests = receipt.archive_digests
  ) THEN
    RAISE EXCEPTION 'x402 seller source deletion requires a verified retention seal'
      USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER x402_seller_settlement_events_retention_delete_guard
BEFORE DELETE ON x402_seller_settlement_events FOR EACH ROW
EXECUTE FUNCTION require_commercial_retention_before_x402_seller_delete();
CREATE TRIGGER x402_seller_nonce_consumptions_retention_delete_guard
BEFORE DELETE ON x402_seller_nonce_consumptions FOR EACH ROW
EXECUTE FUNCTION require_commercial_retention_before_x402_seller_delete();
CREATE TRIGGER x402_seller_receipts_retention_delete_guard
BEFORE DELETE ON x402_seller_receipts FOR EACH ROW
EXECUTE FUNCTION require_commercial_retention_before_x402_seller_delete();
CREATE TRIGGER x402_seller_quotes_retention_delete_guard
BEFORE DELETE ON x402_seller_quotes FOR EACH ROW
EXECUTE FUNCTION require_commercial_retention_before_x402_seller_delete();
CREATE TRIGGER x402_seller_logical_operations_retention_delete_guard
BEFORE DELETE ON x402_seller_logical_operations FOR EACH ROW
EXECUTE FUNCTION require_commercial_retention_before_x402_seller_delete();

CREATE OR REPLACE FUNCTION set_commercial_retention_legal_hold(
  p_subject_id TEXT, p_legal_hold BOOLEAN, p_reason TEXT, p_actor TEXT
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF length(p_reason) NOT BETWEEN 10 AND 500 OR p_actor IS NULL THEN
    RAISE EXCEPTION 'legal hold reason and actor are required' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('app.commercial_retention_purge', 'authorized', true);
  UPDATE public.commercial_retention_subjects SET legal_hold = p_legal_hold WHERE id = p_subject_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'retention subject not found' USING ERRCODE = 'P0002'; END IF;
  INSERT INTO public.commercial_retention_legal_hold_events (
    id, retention_subject_id, legal_hold, reason, actor
  ) VALUES ('rethold_' || encode(gen_random_bytes(16), 'hex'), p_subject_id, p_legal_hold, p_reason, p_actor);
END;
$$;

CREATE OR REPLACE FUNCTION commercial_retention_expiry_eligible(
  p_subject_id TEXT, p_now TIMESTAMPTZ DEFAULT now()
)
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT COALESCE(bool_and(
    retain_until < p_now AND NOT legal_hold AND purged_at IS NULL
  ), false)
    FROM public.commercial_retention_subjects
   WHERE id = p_subject_id
$$;

CREATE OR REPLACE FUNCTION purge_expired_commercial_retention(
  p_subject_id TEXT, p_manifest_digest TEXT, p_actor TEXT, p_confirmation TEXT
)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE subject RECORD; counts JSONB := '{}'::jsonb; deleted_count BIGINT; purge_id TEXT;
BEGIN
  IF p_confirmation <> 'PURGE_EXPIRED_COMMERCIAL_RETENTION' OR p_manifest_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid commercial retention purge authorization' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO subject FROM public.commercial_retention_subjects WHERE id = p_subject_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'retention subject not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT public.commercial_retention_expiry_eligible(p_subject_id, now()) THEN
    RAISE EXCEPTION 'retention subject is not eligible for purge' USING ERRCODE = '55000';
  END IF;
  PERFORM set_config('app.commercial_retention_purge', 'authorized', true);
  DELETE FROM public.commercial_retained_stripe_subscriptions WHERE retention_subject_id = p_subject_id;
  GET DIAGNOSTICS deleted_count = ROW_COUNT; counts := counts || jsonb_build_object('commercial_retained_stripe_subscriptions', deleted_count);
  DELETE FROM public.commercial_retained_stripe_events WHERE retention_subject_id = p_subject_id;
  GET DIAGNOSTICS deleted_count = ROW_COUNT; counts := counts || jsonb_build_object('commercial_retained_stripe_events', deleted_count);
  DELETE FROM public.commercial_retained_charge_facts WHERE retention_subject_id = p_subject_id;
  GET DIAGNOSTICS deleted_count = ROW_COUNT; counts := counts || jsonb_build_object('commercial_retained_charge_facts', deleted_count);
  DELETE FROM public.commercial_retained_x402_events WHERE retention_subject_id = p_subject_id;
  GET DIAGNOSTICS deleted_count = ROW_COUNT; counts := counts || jsonb_build_object('commercial_retained_x402_events', deleted_count);
  DELETE FROM public.commercial_retained_x402_operations WHERE retention_subject_id = p_subject_id;
  GET DIAGNOSTICS deleted_count = ROW_COUNT; counts := counts || jsonb_build_object('commercial_retained_x402_operations', deleted_count);
  DELETE FROM public.commercial_retained_provider_commands WHERE retention_subject_id = p_subject_id;
  GET DIAGNOSTICS deleted_count = ROW_COUNT; counts := counts || jsonb_build_object('commercial_retained_provider_commands', deleted_count);
  DELETE FROM public.commercial_retention_legal_hold_events WHERE retention_subject_id = p_subject_id;
  DELETE FROM public.commercial_retention_receipts WHERE retention_subject_id = p_subject_id;
  DELETE FROM public.commercial_retention_subjects WHERE id = p_subject_id;
  purge_id := 'retpurge_' || encode(gen_random_bytes(16), 'hex');
  INSERT INTO public.commercial_retention_purge_receipts (
    id, retention_subject_id, retirement_receipt_id, manifest_digest, purged_counts, actor
  ) VALUES (purge_id, p_subject_id, subject.retirement_receipt_id, p_manifest_digest, counts, p_actor);
  RETURN purge_id;
END;
$$;

REVOKE ALL PRIVILEGES ON commercial_retention_hmac_keys,
  commercial_retention_subjects, commercial_retention_extractor_registry,
  commercial_retirement_seals, commercial_retention_receipts,
  commercial_retained_stripe_subscriptions, commercial_retained_stripe_events,
  commercial_retained_charge_facts, commercial_retained_x402_operations,
  commercial_retained_x402_events, commercial_retained_provider_commands,
  commercial_retention_legal_hold_events, commercial_retention_purge_receipts FROM PUBLIC;
REVOKE ALL ON FUNCTION commercial_retention_subject_digest(TEXT),
  reject_commercial_activity_after_retention_seal(),
  reject_x402_seller_child_activity_after_retention_seal(),
  reject_x402_seller_immutable_mutation(),
  commercial_retention_extractor_version(TEXT, TEXT),
  commercial_retention_digest_set(REGCLASS, TEXT),
  commercial_retention_source_count(TEXT, TEXT),
  prepare_commercial_financial_retention(TEXT, TEXT),
  require_commercial_retention_before_tenant_delete(),
  require_commercial_retention_before_source_delete(),
  require_commercial_retention_before_x402_seller_delete(),
  set_commercial_retention_legal_hold(TEXT, BOOLEAN, TEXT, TEXT),
  commercial_retention_expiry_eligible(TEXT, TIMESTAMPTZ),
  purge_expired_commercial_retention(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;

DO $$
DECLARE role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY[
    'brain_app', 'brain_privileged', 'brain_wiki_reader', 'brain_mcp_reader',
    'brain_raw_worker', 'brain_canonical_projector', 'brain_ledger_projector',
    'brain_execution_worker', 'brain_audit_verifier', 'brain_audit_publisher',
    'brain_resolver', 'brain_tenant_deletion', 'brain_surface_gateway',
    'brain_surface_audit_writer', 'brain_auth', 'brain_auth_audit_writer',
    'brain_stripe_billing_worker', 'brain_x402_seller_worker',
    'brain_commercial_retention_worker'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON commercial_retention_hmac_keys, commercial_retention_subjects, commercial_retention_extractor_registry, commercial_retirement_seals, commercial_retention_receipts, commercial_retained_stripe_subscriptions, commercial_retained_stripe_events, commercial_retained_charge_facts, commercial_retained_x402_operations, commercial_retained_x402_events, commercial_retained_provider_commands, commercial_retention_legal_hold_events, commercial_retention_purge_receipts FROM %I',
        role_name
      );
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brain_privileged') THEN
    GRANT SELECT ON commercial_retention_subjects,
      commercial_retention_extractor_registry, commercial_retention_receipts,
      commercial_retained_stripe_subscriptions, commercial_retained_stripe_events,
      commercial_retained_charge_facts, commercial_retained_x402_operations,
      commercial_retained_x402_events, commercial_retained_provider_commands,
      commercial_retention_legal_hold_events, commercial_retention_purge_receipts
      TO brain_privileged;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brain_tenant_deletion') THEN
    GRANT EXECUTE ON FUNCTION prepare_commercial_financial_retention(TEXT, TEXT)
      TO brain_tenant_deletion;
  END IF;
END $$;

COMMENT ON TABLE commercial_retention_subjects IS
  'Opaque HMAC-linked subject for minimized commercial evidence retained after tenant erasure.';
COMMENT ON TABLE commercial_retention_hmac_keys IS
  'Database-owned retention HMAC keys. No runtime role can read this table.';
COMMENT ON TABLE commercial_retention_receipts IS
  'Fail-closed extraction count and digest reconciliation committed with tenant deletion.';
COMMENT ON FUNCTION prepare_commercial_financial_retention(TEXT, TEXT) IS
  'Seals provider work, extracts minimized evidence, and writes the required deletion receipt.';

COMMIT;
