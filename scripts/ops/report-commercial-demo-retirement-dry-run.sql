\set ON_ERROR_STOP on
\pset pager off

CREATE TEMP TABLE retirement_cohort (
  tenant_id TEXT PRIMARY KEY
) ON COMMIT PRESERVE ROWS;

CREATE TEMP TABLE self_serve_evidence (
  tenant_id TEXT PRIMARY KEY,
  tenant_present BOOLEAN NOT NULL,
  kind TEXT,
  sandbox BOOLEAN,
  created_via TEXT,
  created_at TIMESTAMPTZ,
  member_count BIGINT NOT NULL,
  non_invalid_member_email_count BIGINT NOT NULL,
  user_count BIGINT NOT NULL,
  login_user_count BIGINT NOT NULL,
  verified_user_count BIGINT NOT NULL,
  non_invalid_user_email_count BIGINT NOT NULL,
  identity_link_count BIGINT NOT NULL,
  active_session_count BIGINT NOT NULL,
  oauth_grant_count BIGINT NOT NULL,
  oauth_token_count BIGINT NOT NULL,
  verification_count BIGINT NOT NULL,
  wallet_identity_count BIGINT NOT NULL,
  api_key_count BIGINT NOT NULL,
  meter_event_count BIGINT NOT NULL,
  raw_artifact_count BIGINT NOT NULL,
  non_demo_source_count BIGINT NOT NULL,
  ledger_activity_count BIGINT NOT NULL,
  proposal_count BIGINT NOT NULL,
  post_creation_audit_count BIGINT NOT NULL,
  abandoned_core_evidence BOOLEAN NOT NULL
) ON COMMIT PRESERVE ROWS;

CREATE TEMP TABLE retirement_targets (
  tenant_id TEXT PRIMARY KEY
) ON COMMIT PRESERVE ROWS;

CREATE TEMP TABLE retirement_exclusions (
  tenant_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL
) ON COMMIT PRESERVE ROWS;

CREATE TEMP TABLE cascade_counts (
  tenant_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  row_count BIGINT NOT NULL,
  disposition TEXT NOT NULL CHECK (disposition IN ('delete', 'preserve')),
  PRIMARY KEY (tenant_id, table_name)
) ON COMMIT PRESERVE ROWS;

CREATE TEMP TABLE tenant_column_registry (
  table_name TEXT PRIMARY KEY,
  column_name TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK (disposition IN ('delete', 'preserve'))
) ON COMMIT PRESERVE ROWS;

SET default_transaction_read_only = on;
SET statement_timeout = '180s';
SET lock_timeout = '1s';

\copy retirement_cohort (tenant_id) FROM '/tmp/commercial-name-exceptions.csv' WITH (FORMAT csv, HEADER true)

DO $$
DECLARE
  cohort_count BIGINT;
  missing_count BIGINT;
  non_demo_count BIGINT;
BEGIN
  SELECT COUNT(*) INTO cohort_count FROM retirement_cohort;
  IF cohort_count <> 1520 THEN
    RAISE EXCEPTION 'fixed retirement cohort count %, expected 1520', cohort_count;
  END IF;

  SELECT COUNT(*)
    INTO missing_count
    FROM retirement_cohort cohort
    LEFT JOIN tenants tenant ON tenant.id = cohort.tenant_id
   WHERE tenant.id IS NULL;
  IF missing_count <> 0 THEN
    RAISE EXCEPTION 'fixed retirement cohort has % missing production tenant rows', missing_count;
  END IF;

  SELECT COUNT(*)
    INTO non_demo_count
    FROM retirement_cohort cohort
    JOIN tenants tenant ON tenant.id = cohort.tenant_id
   WHERE tenant.kind <> 'demo';
  IF non_demo_count <> 0 THEN
    RAISE EXCEPTION 'fixed retirement cohort has % non-demo tenant rows', non_demo_count;
  END IF;
END $$;

INSERT INTO self_serve_evidence
SELECT
  expected.tenant_id,
  tenant.id IS NOT NULL,
  tenant.kind,
  tenant.sandbox,
  tenant.created_via,
  tenant.created_at,
  (SELECT COUNT(*) FROM members row WHERE row.tenant_id = expected.tenant_id),
  (SELECT COUNT(*) FROM members row
    WHERE row.tenant_id = expected.tenant_id
      AND lower(row.email) NOT LIKE 'bootstrap+%@brain.invalid'),
  (SELECT COUNT(*) FROM users row WHERE row.tenant_id = expected.tenant_id),
  (SELECT COUNT(*) FROM users row
    WHERE row.tenant_id = expected.tenant_id AND row.password_hash IS NOT NULL),
  (SELECT COUNT(*) FROM users row
    WHERE row.tenant_id = expected.tenant_id AND row.email_verified_at IS NOT NULL),
  (SELECT COUNT(*) FROM users row
    WHERE row.tenant_id = expected.tenant_id
      AND lower(row.email) NOT LIKE 'bootstrap+%@brain.invalid'),
  (SELECT COUNT(*) FROM member_identity_links row WHERE row.tenant_id = expected.tenant_id),
  (SELECT COUNT(*) FROM session_refresh_tokens row
    WHERE row.tenant_id = expected.tenant_id
      AND row.revoked_at IS NULL
      AND row.expires_at > now()),
  (SELECT COUNT(*) FROM oauth_consent_grants row WHERE row.tenant_id = expected.tenant_id),
  (
    (SELECT COUNT(*) FROM oauth_authorization_codes row WHERE row.tenant_id = expected.tenant_id)
    + (SELECT COUNT(*) FROM oauth_refresh_tokens row WHERE row.tenant_id = expected.tenant_id)
  ),
  (SELECT COUNT(*) FROM email_verifications row WHERE row.tenant_id = expected.tenant_id),
  (SELECT COUNT(*) FROM wallet_identities row WHERE row.tenant_id = expected.tenant_id),
  (SELECT COUNT(*) FROM api_keys row WHERE row.tenant_id = expected.tenant_id),
  (SELECT COUNT(*) FROM api_request_meter_events row WHERE row.tenant_id = expected.tenant_id),
  (SELECT COUNT(*) FROM raw_artifacts row WHERE row.tenant_id = expected.tenant_id),
  (SELECT COUNT(*) FROM raw_sources row
    WHERE row.tenant_id = expected.tenant_id
      AND row.metadata->>'demo_seed_kind' IS NULL
      AND row.is_stub = false),
  (
    (SELECT COUNT(*) FROM ledger_transactions row WHERE row.owner_id = expected.tenant_id)
    + (SELECT COUNT(*) FROM ledger_invoices row WHERE row.owner_id = expected.tenant_id)
    + (SELECT COUNT(*) FROM ledger_payment_intents row WHERE row.owner_id = expected.tenant_id)
  ),
  (SELECT COUNT(*) FROM proposals row WHERE row.tenant_id = expected.tenant_id),
  (SELECT COUNT(*) FROM audit_events row
    WHERE row.tenant_id = expected.tenant_id
      AND row.created_at > tenant.created_at + interval '24 hours'),
  (
    tenant.id IS NOT NULL
    AND tenant.kind = 'demo'
    AND tenant.sandbox = true
    AND tenant.created_via = 'self_serve'
    AND (SELECT COUNT(*) FROM members row
      WHERE row.tenant_id = expected.tenant_id
        AND lower(row.email) NOT LIKE 'bootstrap+%@brain.invalid') = 0
    AND (SELECT COUNT(*) FROM users row
      WHERE row.tenant_id = expected.tenant_id AND row.password_hash IS NOT NULL) = 0
    AND (SELECT COUNT(*) FROM users row
      WHERE row.tenant_id = expected.tenant_id AND row.email_verified_at IS NOT NULL) = 0
    AND (SELECT COUNT(*) FROM users row
      WHERE row.tenant_id = expected.tenant_id
        AND lower(row.email) NOT LIKE 'bootstrap+%@brain.invalid') = 0
    AND (SELECT COUNT(*) FROM member_identity_links row WHERE row.tenant_id = expected.tenant_id) = 0
    AND (SELECT COUNT(*) FROM session_refresh_tokens row
      WHERE row.tenant_id = expected.tenant_id
        AND row.revoked_at IS NULL
        AND row.expires_at > now()) = 0
    AND (SELECT COUNT(*) FROM oauth_consent_grants row WHERE row.tenant_id = expected.tenant_id) = 0
    AND (SELECT COUNT(*) FROM oauth_authorization_codes row WHERE row.tenant_id = expected.tenant_id) = 0
    AND (SELECT COUNT(*) FROM oauth_refresh_tokens row WHERE row.tenant_id = expected.tenant_id) = 0
    AND (SELECT COUNT(*) FROM email_verifications row WHERE row.tenant_id = expected.tenant_id) = 0
    AND (SELECT COUNT(*) FROM wallet_identities row WHERE row.tenant_id = expected.tenant_id) = 0
    AND (SELECT COUNT(*) FROM api_keys row WHERE row.tenant_id = expected.tenant_id) = 0
    AND (SELECT COUNT(*) FROM api_request_meter_events row WHERE row.tenant_id = expected.tenant_id) = 0
    AND (SELECT COUNT(*) FROM raw_artifacts row WHERE row.tenant_id = expected.tenant_id) = 0
    AND (SELECT COUNT(*) FROM raw_sources row
      WHERE row.tenant_id = expected.tenant_id
        AND row.metadata->>'demo_seed_kind' IS NULL
        AND row.is_stub = false) = 0
    AND (SELECT COUNT(*) FROM ledger_transactions row WHERE row.owner_id = expected.tenant_id) = 0
    AND (SELECT COUNT(*) FROM ledger_invoices row WHERE row.owner_id = expected.tenant_id) = 0
    AND (SELECT COUNT(*) FROM ledger_payment_intents row WHERE row.owner_id = expected.tenant_id) = 0
    AND (SELECT COUNT(*) FROM proposals row WHERE row.tenant_id = expected.tenant_id) = 0
    AND (SELECT COUNT(*) FROM audit_events row
      WHERE row.tenant_id = expected.tenant_id
        AND row.created_at > tenant.created_at + interval '24 hours') = 0
  ) AS abandoned_core_evidence
FROM (VALUES
  ('tnt_01KWS1GM8ANDN1ZNMQW9QGQEAP'),
  ('tnt_01KWS1MBE9MRV615H8TCXNC6MQ'),
  ('tnt_01KWS1MPWAEEA9Z72KZ0YCMKTP')
) expected(tenant_id)
LEFT JOIN tenants tenant ON tenant.id = expected.tenant_id;

INSERT INTO retirement_exclusions (tenant_id, reason)
SELECT cohort.tenant_id, 'production_golden_demo_tenant'
  FROM retirement_cohort cohort
 WHERE cohort.tenant_id = 'tnt_00000000010000000000000000'
UNION ALL
SELECT cohort.tenant_id, 'shared_continue_with_demo_tenant'
  FROM retirement_cohort cohort
 WHERE cohort.tenant_id = 'tnt_01KYAT7A1QRKHTYW9H4RAR2SEX'
UNION ALL
SELECT cohort.tenant_id, 'september_or_later_safety_exclusion'
  FROM retirement_cohort cohort
  JOIN tenants tenant ON tenant.id = cohort.tenant_id
 WHERE tenant.created_at >= '2026-09-01 00:00:00+00'::timestamptz
UNION ALL
SELECT evidence.tenant_id, 'self_serve_not_proven_abandoned'
  FROM self_serve_evidence evidence
 WHERE NOT evidence.abandoned_core_evidence;

INSERT INTO retirement_targets (tenant_id)
SELECT cohort.tenant_id
  FROM retirement_cohort cohort
 WHERE NOT EXISTS (
   SELECT 1 FROM retirement_exclusions exclusion
    WHERE exclusion.tenant_id = cohort.tenant_id
 )
 ORDER BY cohort.tenant_id;

DO $$
DECLARE
  target_count BIGINT;
  unsafe_self_serve_count BIGINT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM retirement_targets
     WHERE tenant_id IN (
       'tnt_00000000010000000000000000',
       'tnt_01KYAT7A1QRKHTYW9H4RAR2SEX'
     )
  ) THEN
    RAISE EXCEPTION 'protected demo tenant reached retirement targets';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM retirement_targets target
      JOIN tenants tenant ON tenant.id = target.tenant_id
     WHERE tenant.created_at >= '2026-09-01 00:00:00+00'::timestamptz
  ) THEN
    RAISE EXCEPTION 'September or later tenant reached retirement targets';
  END IF;

  SELECT COUNT(*) INTO unsafe_self_serve_count
    FROM retirement_targets target
    JOIN self_serve_evidence evidence ON evidence.tenant_id = target.tenant_id
   WHERE NOT evidence.abandoned_core_evidence;
  IF unsafe_self_serve_count <> 0 THEN
    RAISE EXCEPTION 'unproven self-serve tenant reached retirement targets';
  END IF;

  SELECT COUNT(*) INTO target_count FROM retirement_targets;
  IF target_count < 1516 OR target_count > 1519 THEN
    RAISE EXCEPTION 'unexpected target count %', target_count;
  END IF;
END $$;

INSERT INTO tenant_column_registry (table_name, column_name, disposition)
SELECT DISTINCT ON (catalog_column.table_name)
       catalog_column.table_name,
       catalog_column.column_name,
       CASE
         WHEN catalog_column.table_name IN (
           'audit_events',
           'audit_anchors',
           'tenant_blob_purge_jobs',
           'tenant_blob_purge_audit_outbox',
           'audit_integrity_findings'
         ) THEN 'preserve'
         ELSE 'delete'
       END
  FROM information_schema.columns catalog_column
  JOIN information_schema.tables relation
    ON relation.table_schema = catalog_column.table_schema
   AND relation.table_name = catalog_column.table_name
 WHERE catalog_column.table_schema = 'public'
   AND relation.table_type = 'BASE TABLE'
   AND catalog_column.column_name IN ('tenant_id', 'owner_id', 'brain_tenant_id')
 ORDER BY catalog_column.table_name,
          CASE catalog_column.column_name
            WHEN 'tenant_id' THEN 1
            WHEN 'owner_id' THEN 2
            ELSE 3
          END;

DO $$
DECLARE
  registry_row RECORD;
BEGIN
  FOR registry_row IN
    SELECT table_name, column_name, disposition
      FROM tenant_column_registry
     ORDER BY table_name
  LOOP
    EXECUTE format(
      'INSERT INTO cascade_counts (tenant_id, table_name, row_count, disposition)
       SELECT target.tenant_id, %L, COUNT(row.*), %L
         FROM retirement_targets target
         LEFT JOIN %I row ON row.%I = target.tenant_id
        GROUP BY target.tenant_id',
      registry_row.table_name,
      registry_row.disposition,
      registry_row.table_name,
      registry_row.column_name
    );
  END LOOP;
END $$;

INSERT INTO cascade_counts (tenant_id, table_name, row_count, disposition)
SELECT target.tenant_id, 'tenants', COUNT(tenant.*), 'delete'
  FROM retirement_targets target
  LEFT JOIN tenants tenant ON tenant.id = target.tenant_id
 GROUP BY target.tenant_id;

SELECT json_build_object(
  'event', 'commercial_demo_retirement_dry_run',
  'cohort_count', (SELECT COUNT(*) FROM retirement_cohort),
  'target_count', (SELECT COUNT(*) FROM retirement_targets),
  'excluded_count', (SELECT COUNT(*) FROM retirement_exclusions),
  'golden_demo_in_cohort', EXISTS (
    SELECT 1 FROM retirement_cohort
     WHERE tenant_id = 'tnt_00000000010000000000000000'
  ),
  'shared_continue_with_demo_in_cohort', EXISTS (
    SELECT 1 FROM retirement_cohort
     WHERE tenant_id = 'tnt_01KYAT7A1QRKHTYW9H4RAR2SEX'
  ),
  'september_target_overlap', (
    SELECT COUNT(*)
      FROM retirement_targets target
      JOIN tenants tenant ON tenant.id = target.tenant_id
     WHERE tenant.created_at >= '2026-09-01 00:00:00+00'::timestamptz
  ),
  'rows_that_would_delete', (
    SELECT COALESCE(SUM(row_count), 0) FROM cascade_counts WHERE disposition = 'delete'
  ),
  'rows_that_would_preserve', (
    SELECT COALESCE(SUM(row_count), 0) FROM cascade_counts WHERE disposition = 'preserve'
  ),
  'blob_rows_that_would_enqueue_purge', (
    SELECT COALESCE(SUM(row_count), 0)
      FROM cascade_counts
     WHERE table_name = 'raw_artifacts'
  )
)::text;

SELECT json_build_object(
  'event', 'commercial_demo_retirement_table_effect',
  'table_name', table_name,
  'disposition', disposition,
  'row_count', SUM(row_count),
  'tenant_count', COUNT(*) FILTER (WHERE row_count > 0)
)::text
FROM cascade_counts
GROUP BY table_name, disposition
HAVING SUM(row_count) > 0
ORDER BY disposition, table_name;

\copy (SELECT tenant_id FROM retirement_targets ORDER BY tenant_id) TO '/tmp/commercial-demo-retirement-targets.csv' WITH (FORMAT csv, HEADER true)
\copy (SELECT * FROM retirement_exclusions ORDER BY tenant_id) TO '/tmp/commercial-demo-retirement-exclusions.csv' WITH (FORMAT csv, HEADER true)
\copy (SELECT * FROM self_serve_evidence ORDER BY tenant_id) TO '/tmp/commercial-demo-retirement-self-serve-evidence.csv' WITH (FORMAT csv, HEADER true)
COPY (
  SELECT target.tenant_id,
         tenant.created_at,
         tenant.kind,
         tenant.sandbox,
         tenant.created_via,
         COALESCE(SUM(count.row_count) FILTER (WHERE count.disposition = 'delete'), 0)
           AS total_rows_to_delete,
         COALESCE(SUM(count.row_count) FILTER (WHERE count.disposition = 'preserve'), 0)
           AS total_rows_to_preserve,
         COALESCE(MAX(count.row_count) FILTER (WHERE count.table_name = 'ledger_transactions'), 0)
           AS ledger_transactions_to_delete,
         COALESCE(MAX(count.row_count) FILTER (WHERE count.table_name = 'ledger_invoices'), 0)
           AS ledger_invoices_to_delete,
         COALESCE(MAX(count.row_count) FILTER (WHERE count.table_name = 'ledger_payment_intents'), 0)
           AS payment_intents_to_delete,
         COALESCE(MAX(count.row_count) FILTER (WHERE count.table_name = 'proposals'), 0)
           AS proposals_to_delete,
         COALESCE(MAX(count.row_count) FILTER (WHERE count.table_name = 'raw_artifacts'), 0)
           AS raw_artifact_rows_to_delete,
         COALESCE(MAX(count.row_count) FILTER (WHERE count.table_name = 'audit_events'), 0)
           AS audit_events_to_preserve,
         COALESCE(MAX(count.row_count) FILTER (WHERE count.table_name = 'audit_anchors'), 0)
           AS audit_anchors_to_preserve
    FROM retirement_targets target
    JOIN tenants tenant ON tenant.id = target.tenant_id
    LEFT JOIN cascade_counts count ON count.tenant_id = target.tenant_id
   GROUP BY target.tenant_id, tenant.created_at, tenant.kind, tenant.sandbox, tenant.created_via
   ORDER BY target.tenant_id
) TO '/tmp/commercial-demo-retirement-per-tenant-effects.csv' WITH (FORMAT csv, HEADER true);
COPY (
  SELECT table_name,
         disposition,
         SUM(row_count) AS row_count,
         COUNT(*) FILTER (WHERE row_count > 0) AS tenant_count
    FROM cascade_counts
   GROUP BY table_name, disposition
   ORDER BY disposition, table_name
) TO '/tmp/commercial-demo-retirement-per-table-effects.csv' WITH (FORMAT csv, HEADER true);
COPY (
  SELECT artifact.tenant_id,
         artifact.id AS artifact_id,
         artifact.blob_uri,
         encode(artifact.sha256, 'hex') AS sha256,
         artifact.bytes
    FROM raw_artifacts artifact
    JOIN retirement_targets target ON target.tenant_id = artifact.tenant_id
   ORDER BY artifact.tenant_id, artifact.id
) TO '/tmp/commercial-demo-retirement-blob-manifest.csv' WITH (FORMAT csv, HEADER true);
COPY (
  SELECT tenant.id AS tenant_id,
         tenant.created_at,
         tenant.kind,
         tenant.sandbox,
         tenant.created_via,
         (SELECT COUNT(*) FROM api_keys key WHERE key.tenant_id = tenant.id) AS api_key_count,
         (SELECT COUNT(*) FROM api_request_meter_events event WHERE event.tenant_id = tenant.id)
           AS request_meter_event_count,
         EXISTS (
           SELECT 1 FROM retirement_targets target WHERE target.tenant_id = tenant.id
         ) AS overlaps_retirement_targets
    FROM tenants tenant
   WHERE tenant.created_at >= '2026-09-01 00:00:00+00'::timestamptz
   ORDER BY tenant.created_at, tenant.id
) TO '/tmp/commercial-demo-retirement-september-safety.csv' WITH (FORMAT csv, HEADER true);
