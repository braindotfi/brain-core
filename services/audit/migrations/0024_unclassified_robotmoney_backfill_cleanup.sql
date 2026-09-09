-- Convert entities created through the legacy-name compatibility path into
-- explicit drafts, then restore the canonical tenant business name to null.

BEGIN;

UPDATE robotmoney_entities AS entity
   SET display_name = deferred.tenant_key,
       legal_name = NULL,
       state = 'draft',
       created_by = 'commercial_unclassified_legacy_v1',
       updated_at = now()
  FROM robotmoney_entity_backfill_deferred_tenants AS deferred
 WHERE entity.tenant_id = deferred.tenant_key
   AND entity.created_by = 'commercial_entity_backfill_v1';

UPDATE tenants AS tenant
   SET business_name = NULL,
       updated_at = now()
  FROM robotmoney_entity_backfill_deferred_tenants AS deferred
 WHERE tenant.id = deferred.tenant_key
   AND tenant.business_name = 'brain-unclassified-legacy:' || tenant.id;

DO $$
DECLARE
  invalid_count BIGINT;
BEGIN
  SELECT count(*) INTO invalid_count
    FROM robotmoney_entity_backfill_deferred_tenants AS deferred
    JOIN tenants AS tenant ON tenant.id = deferred.tenant_key
    LEFT JOIN robotmoney_entities AS entity ON entity.tenant_id = deferred.tenant_key
   WHERE tenant.business_name IS NOT NULL
      OR entity.id IS NULL
      OR entity.state <> 'draft'
      OR entity.legal_name IS NOT NULL
      OR entity.created_by <> 'commercial_unclassified_legacy_v1';

  IF invalid_count > 0 THEN
    RAISE EXCEPTION
      'RobotMoney legacy compatibility cleanup left % invalid tenant(s)',
      invalid_count;
  END IF;
END $$;

DROP TABLE robotmoney_entity_backfill_deferred_tenants;

COMMIT;
