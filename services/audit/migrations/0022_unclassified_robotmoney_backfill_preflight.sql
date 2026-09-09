-- Preserve legacy tenants without a recoverable business name across the
-- append-only 0023 RobotMoney entity backfill. The temporary value exists
-- only between this migration and 0024 and is never an asserted legal name.

BEGIN;

WITH latest_graduation_name AS (
  SELECT DISTINCT ON (tenant_id)
         tenant_id,
         NULLIF(btrim(payload ->> 'legalBusinessName'), '') AS business_name
    FROM tenant_graduation_evidence
   WHERE evidence_type = 'business_profile'
     AND NULLIF(btrim(payload ->> 'legalBusinessName'), '') IS NOT NULL
   ORDER BY tenant_id, evidence_version DESC, created_at DESC, id DESC
),
latest_creation_name AS (
  SELECT DISTINCT ON (tenant_id)
         tenant_id,
         NULLIF(btrim(inputs ->> 'company_name'), '') AS business_name
    FROM audit_events
   WHERE action = 'tenant.created'
     AND NULLIF(btrim(inputs ->> 'company_name'), '') IS NOT NULL
   ORDER BY tenant_id, created_at DESC, id DESC
)
UPDATE tenants AS tenant
   SET business_name = COALESCE(creation.business_name, graduation.business_name),
       updated_at = now()
  FROM latest_creation_name AS creation
  FULL JOIN latest_graduation_name AS graduation
    ON graduation.tenant_id = creation.tenant_id
 WHERE tenant.id = COALESCE(graduation.tenant_id, creation.tenant_id)
   AND tenant.business_name IS NULL
   AND COALESCE(creation.business_name, graduation.business_name) IS NOT NULL;

CREATE TABLE robotmoney_entity_backfill_deferred_tenants (
  tenant_key TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE
);

INSERT INTO robotmoney_entity_backfill_deferred_tenants (tenant_key)
SELECT id
  FROM tenants
 WHERE business_name IS NULL OR btrim(business_name) = ''
ON CONFLICT (tenant_key) DO NOTHING;

UPDATE tenants AS tenant
   SET business_name = 'brain-unclassified-legacy:' || tenant.id,
       updated_at = now()
  FROM robotmoney_entity_backfill_deferred_tenants AS deferred
 WHERE tenant.id = deferred.tenant_key;

COMMIT;
