-- Tier 1 follow-up A5: API-owned tenant tables must FORCE RLS in the app
-- migration set, not only in the operator role script. This keeps owner-role
-- connections subject to the tenant policies.

BEGIN;

ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
ALTER TABLE wallet_identities FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_blob_purge_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_blob_purge_audit_outbox FORCE ROW LEVEL SECURITY;
ALTER TABLE email_verifications FORCE ROW LEVEL SECURITY;

COMMIT;
