-- Install RFC 0010 member references after execution migration 0023 creates
-- members. API migrations run before execution migrations on a fresh database.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'tenant_graduation_requests_initiated_by_member_fk'
       AND conrelid = 'tenant_graduation_requests'::regclass
  ) THEN
    ALTER TABLE tenant_graduation_requests
      ADD CONSTRAINT tenant_graduation_requests_initiated_by_member_fk
      FOREIGN KEY (tenant_id, initiated_by_member_id)
      REFERENCES members(tenant_id, id)
      ON UPDATE CASCADE
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'tenant_graduation_evidence_submitted_by_member_fk'
       AND conrelid = 'tenant_graduation_evidence'::regclass
  ) THEN
    ALTER TABLE tenant_graduation_evidence
      ADD CONSTRAINT tenant_graduation_evidence_submitted_by_member_fk
      FOREIGN KEY (tenant_id, submitted_by_member_id)
      REFERENCES members(tenant_id, id)
      ON UPDATE CASCADE
      ON DELETE RESTRICT;
  END IF;
END $$;

COMMIT;
