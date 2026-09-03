-- Recover the canonical tenant business name from accepted historical inputs,
-- then create exactly one default RobotMoney entity for every existing tenant.

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

DO $$
DECLARE
  unresolved_count BIGINT;
BEGIN
  SELECT count(*) INTO unresolved_count
    FROM tenants
   WHERE business_name IS NULL OR btrim(business_name) = '';

  IF unresolved_count > 0 THEN
    RAISE EXCEPTION
      'RobotMoney entity backfill found % tenant(s) without a recoverable business name',
      unresolved_count;
  END IF;
END $$;

INSERT INTO robotmoney_entities (
  id,
  tenant_id,
  display_name,
  legal_name,
  state,
  commercial_cap_revision_id,
  created_by
)
SELECT
  'rme_' || upper(substr(md5(tenant.id), 1, 26)),
  tenant.id,
  tenant.business_name,
  tenant.business_name,
  'active',
  NULL,
  'commercial_entity_backfill_v1'
FROM tenants AS tenant
WHERE NOT EXISTS (
  SELECT 1
    FROM robotmoney_entities AS entity
   WHERE entity.tenant_id = tenant.id
);

DO $$
DECLARE
  invalid_count BIGINT;
BEGIN
  SELECT count(*) INTO invalid_count
    FROM tenants AS tenant
    LEFT JOIN robotmoney_entities AS entity
      ON entity.tenant_id = tenant.id
   GROUP BY tenant.id
  HAVING count(entity.id) <> 1
  LIMIT 1;

  IF invalid_count IS NOT NULL THEN
    RAISE EXCEPTION 'RobotMoney default entity backfill did not produce exactly one entity per tenant';
  END IF;
END $$;

COMMIT;
