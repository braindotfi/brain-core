BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS evidence (
  id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('pdf', 'record', 'mail', 'image', 'external', 'report', 'data')),
  name TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('uploaded', 'emailed', 'synced', 'generated', 'external_link')),
  storage_ref TEXT NOT NULL,
  sha256 TEXT CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  mime_type TEXT NOT NULL,
  byte_size BIGINT NOT NULL CHECK (byte_size >= 0),
  captured_at TIMESTAMPTZ NOT NULL,
  captured_by TEXT NOT NULL,
  retention_class TEXT NOT NULL CHECK (retention_class IN ('standard', 'compliance_7yr', 'permanent')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  archived_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  delete_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_evidence_tenant_created
  ON evidence (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_evidence_tenant_kind_created
  ON evidence (tenant_id, kind, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_evidence_tenant_captured
  ON evidence (tenant_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS proposal_evidence_links (
  tenant_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  evidence_id UUID NOT NULL REFERENCES evidence(id) ON DELETE RESTRICT,
  source_ref JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, proposal_id, evidence_id)
);

CREATE INDEX IF NOT EXISTS idx_proposal_evidence_links_evidence
  ON proposal_evidence_links (tenant_id, evidence_id);

ALTER TABLE evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence FORCE ROW LEVEL SECURITY;

CREATE POLICY evidence_tenant_read ON evidence
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY evidence_tenant_insert ON evidence
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY evidence_tenant_update ON evidence
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE proposal_evidence_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE proposal_evidence_links FORCE ROW LEVEL SECURITY;

CREATE POLICY proposal_evidence_links_tenant_read ON proposal_evidence_links
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY proposal_evidence_links_tenant_insert ON proposal_evidence_links
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY proposal_evidence_links_tenant_update ON proposal_evidence_links
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

WITH refs AS (
  SELECT
    p.tenant_id,
    p.id AS proposal_id,
    item AS source_ref,
    COALESCE(NULLIF(item->>'kind', ''), 'external') AS ref_kind,
    COALESCE(NULLIF(item->>'ref', ''), NULLIF(item->>'id', ''), item::text) AS ref_value
  FROM proposals p
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(p.action->'evidence_refs') = 'array' THEN p.action->'evidence_refs'
      ELSE '[]'::jsonb
    END
  ) AS item
  UNION ALL
  SELECT
    p.tenant_id,
    p.id AS proposal_id,
    jsonb_build_object('kind', 'legacy', 'ref', item #>> '{}') AS source_ref,
    'external' AS ref_kind,
    item #>> '{}' AS ref_value
  FROM proposals p
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(p.action->'evidence_ids') = 'array' THEN p.action->'evidence_ids'
      ELSE '[]'::jsonb
    END
  ) AS item
),
inserted AS (
  INSERT INTO evidence (
    id, tenant_id, kind, name, source, storage_ref, sha256, mime_type,
    byte_size, captured_at, captured_by, retention_class, metadata
  )
  SELECT
    gen_random_uuid(),
    refs.tenant_id,
    'external',
    concat(refs.ref_kind, ': ', left(refs.ref_value, 120)),
    'external_link',
    CASE
      WHEN refs.ref_value LIKE 'http://%' OR refs.ref_value LIKE 'https://%' THEN refs.ref_value
      ELSE concat('external:', refs.ref_value)
    END,
    NULL,
    'text/uri-list',
    0,
    now(),
    'system:migration',
    'standard',
    jsonb_build_object(
      'proposal_id', refs.proposal_id,
      'legacy_ref', refs.source_ref,
      'materialized_from', 'proposal_payload'
    )
  FROM refs
  WHERE refs.ref_value IS NOT NULL
  RETURNING id, tenant_id, metadata
)
INSERT INTO proposal_evidence_links (tenant_id, proposal_id, evidence_id, source_ref)
SELECT
  tenant_id,
  metadata->>'proposal_id',
  id,
  metadata->'legacy_ref'
FROM inserted
ON CONFLICT DO NOTHING;

COMMIT;
