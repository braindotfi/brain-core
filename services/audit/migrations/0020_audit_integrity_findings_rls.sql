-- Enable row-level security on audit_integrity_findings.
--
-- The audit verifier writes this table through the BYPASSRLS verifier pool,
-- but the rows are tenant-keyed and may be read by diagnostic or health paths.
-- RLS is therefore still the defense-in-depth backstop for ordinary
-- request-path connections. The verifier's privileged role bypasses these
-- policies by design.

BEGIN;

ALTER TABLE audit_integrity_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_integrity_findings FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON audit_integrity_findings
  USING (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY tenant_isolation_write ON audit_integrity_findings
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

COMMIT;
