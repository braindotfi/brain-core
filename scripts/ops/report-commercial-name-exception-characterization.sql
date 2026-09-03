\set ON_ERROR_STOP on
\pset pager off

SET default_transaction_read_only = on;
SET statement_timeout = '90s';
SET lock_timeout = '1s';

CREATE TEMP TABLE exception_tenants (
  tenant_id TEXT PRIMARY KEY
) ON COMMIT PRESERVE ROWS;

\copy exception_tenants (tenant_id) FROM '/tmp/commercial-name-exceptions.csv' WITH (FORMAT csv, HEADER true)

CREATE TEMP TABLE exception_characterization ON COMMIT PRESERVE ROWS AS
SELECT
  tenant.id AS tenant_id,
  tenant.created_at,
  tenant.kind,
  tenant.sandbox,
  tenant.created_via,
  tenant.provisioning_state,
  tenant.data_profile,
  tenant.access_stage,
  (
    tenant.kind = 'demo'
    OR tenant.provisioning_state IN ('ready_demo', 'seed_failed', 'archived')
    OR tenant.data_profile = 'synthetic_brightline_v1'
    OR tenant.access_stage = 'demo'
    OR tenant.created_via = 'seed'
    OR tenant.id = 'tnt_00000000010000000000000000'
    OR demo_audit.present
    OR demo_source.present
    OR member_markers.invalid_bootstrap_email
    OR member_markers.explicit_test_email
  ) AS disposable_marker,
  demo_audit.present AS demo_audit_marker,
  demo_source.present AS demo_source_marker,
  member_markers.invalid_bootstrap_email,
  member_markers.explicit_test_email,
  member_markers.member_count,
  activity.raw_artifact_present,
  activity.non_demo_source_present,
  activity.ledger_transaction_present,
  activity.ledger_invoice_present,
  activity.payment_intent_present,
  activity.proposal_present,
  activity.api_key_present,
  activity.post_creation_audit_present,
  (
    activity.raw_artifact_present
    OR activity.non_demo_source_present
    OR activity.ledger_transaction_present
    OR activity.ledger_invoice_present
    OR activity.payment_intent_present
    OR activity.proposal_present
    OR activity.api_key_present
    OR activity.post_creation_audit_present
  ) AS activity_present
FROM exception_tenants exception
JOIN tenants tenant ON tenant.id = exception.tenant_id
CROSS JOIN LATERAL (
  SELECT
    EXISTS (
      SELECT 1
      FROM audit_events event
      WHERE event.tenant_id = tenant.id
        AND event.action IN ('tenant.demo_seeded', 'demo.provisioned')
      LIMIT 1
    ) AS present
) demo_audit
CROSS JOIN LATERAL (
  SELECT
    EXISTS (
      SELECT 1
      FROM raw_sources source
      WHERE source.tenant_id = tenant.id
        AND source.metadata->>'demo_seed_kind' IS NOT NULL
      LIMIT 1
    ) AS present
) demo_source
CROSS JOIN LATERAL (
  SELECT
    COUNT(*)::INTEGER AS member_count,
    COALESCE(bool_or(lower(member.email) LIKE 'bootstrap+%@brain.invalid'), false)
      AS invalid_bootstrap_email,
    COALESCE(bool_or(
      lower(member.email) ~ '(@example\\.(com|org|net)|@test\\.|@localhost$|@brain\\.invalid$)'
    ), false) AS explicit_test_email
  FROM members member
  WHERE member.tenant_id = tenant.id
) member_markers
CROSS JOIN LATERAL (
  SELECT
    EXISTS (
      SELECT 1 FROM raw_artifacts artifact
      WHERE artifact.tenant_id = tenant.id
      LIMIT 1
    ) AS raw_artifact_present,
    EXISTS (
      SELECT 1 FROM raw_sources source
      WHERE source.tenant_id = tenant.id
        AND source.metadata->>'demo_seed_kind' IS NULL
        AND source.is_stub = false
      LIMIT 1
    ) AS non_demo_source_present,
    EXISTS (
      SELECT 1 FROM ledger_transactions ledger_row
      WHERE ledger_row.owner_id = tenant.id
      LIMIT 1
    ) AS ledger_transaction_present,
    EXISTS (
      SELECT 1 FROM ledger_invoices invoice
      WHERE invoice.owner_id = tenant.id
      LIMIT 1
    ) AS ledger_invoice_present,
    EXISTS (
      SELECT 1 FROM ledger_payment_intents payment
      WHERE payment.owner_id = tenant.id
      LIMIT 1
    ) AS payment_intent_present,
    EXISTS (
      SELECT 1 FROM proposals proposal
      WHERE proposal.tenant_id = tenant.id
      LIMIT 1
    ) AS proposal_present,
    EXISTS (
      SELECT 1 FROM api_keys key
      WHERE key.tenant_id = tenant.id
      LIMIT 1
    ) AS api_key_present,
    EXISTS (
      SELECT 1 FROM audit_events event
      WHERE event.tenant_id = tenant.id
        AND event.created_at > tenant.created_at + interval '24 hours'
      LIMIT 1
    ) AS post_creation_audit_present
) activity;

SELECT json_build_object(
  'event', 'commercial_name_exception_characterization',
  'exception_rows', COUNT(*),
  'disposable', COUNT(*) FILTER (WHERE disposable_marker),
  'not_disposable', COUNT(*) FILTER (WHERE NOT disposable_marker),
  'not_disposable_with_activity', COUNT(*) FILTER (
    WHERE NOT disposable_marker AND activity_present
  ),
  'not_disposable_without_activity', COUNT(*) FILTER (
    WHERE NOT disposable_marker AND NOT activity_present
  )
)::text
FROM exception_characterization;

SELECT json_build_object(
  'event', 'commercial_name_exception_posture',
  'kind', kind,
  'sandbox', sandbox,
  'created_via', created_via,
  'provisioning_state', provisioning_state,
  'data_profile', data_profile,
  'access_stage', access_stage,
  'count', COUNT(*)
)::text
FROM exception_characterization
GROUP BY kind, sandbox, created_via, provisioning_state, data_profile, access_stage
ORDER BY COUNT(*) DESC, kind, sandbox, created_via;

SELECT json_build_object(
  'event', 'commercial_name_exception_markers',
  'demo_audit', COUNT(*) FILTER (WHERE demo_audit_marker),
  'demo_source', COUNT(*) FILTER (WHERE demo_source_marker),
  'invalid_bootstrap_email', COUNT(*) FILTER (WHERE invalid_bootstrap_email),
  'explicit_test_email', COUNT(*) FILTER (WHERE explicit_test_email),
  'raw_artifact', COUNT(*) FILTER (WHERE raw_artifact_present),
  'non_demo_source', COUNT(*) FILTER (WHERE non_demo_source_present),
  'ledger_transaction', COUNT(*) FILTER (WHERE ledger_transaction_present),
  'ledger_invoice', COUNT(*) FILTER (WHERE ledger_invoice_present),
  'payment_intent', COUNT(*) FILTER (WHERE payment_intent_present),
  'proposal', COUNT(*) FILTER (WHERE proposal_present),
  'api_key', COUNT(*) FILTER (WHERE api_key_present),
  'post_creation_audit', COUNT(*) FILTER (WHERE post_creation_audit_present)
)::text
FROM exception_characterization;

SELECT json_build_object(
  'event', 'commercial_name_exception_created_day',
  'day', created_at::date,
  'count', COUNT(*),
  'disposable', COUNT(*) FILTER (WHERE disposable_marker),
  'not_disposable', COUNT(*) FILTER (WHERE NOT disposable_marker)
)::text
FROM exception_characterization
GROUP BY created_at::date
ORDER BY created_at::date;

\copy (SELECT * FROM exception_characterization ORDER BY tenant_id) TO '/tmp/commercial-name-exception-characterization.csv' WITH (FORMAT csv, HEADER true)
