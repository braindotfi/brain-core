-- P0.4: approver / quorum hardening.
--
-- Adds the columns the §6 gate (check 11) needs to reject revoked, cross-tenant,
-- duplicate, and stale-policy-version signatures, plus a status lifecycle so the
-- gate counts only currently-valid approvals toward quorum.
--
--   policy_version   — tenant policy version active when the approver signed.
--                      A signature against a superseded version is invalidated.
--   revoked_at       — set when the approval (or its signer) is revoked.
--   signer_tenant_id — denormalized signer tenant for the cross-tenant guard.
--   status           — 'valid' | 'stale' | 'revoked'. Only 'valid' counts.
--
-- The pre-existing UNIQUE (tenant_id, subject_type, subject_id,
-- approver_principal_id) already enforces "one signature per (subject, signer)"
-- (the prompt's UNIQUE(intent_id, signer_id)); ApprovalService now turns a
-- second attempt into a hard reject (approval_duplicate_signer) rather than a
-- silent no-op.

BEGIN;

ALTER TABLE approvals
  ADD COLUMN IF NOT EXISTS policy_version   INTEGER,
  ADD COLUMN IF NOT EXISTS revoked_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS signer_tenant_id TEXT,
  ADD COLUMN IF NOT EXISTS status           TEXT NOT NULL DEFAULT 'valid'
                             CHECK (status IN ('valid', 'stale', 'revoked'));

-- Back-compat: existing rows are same-tenant and remain valid.
UPDATE approvals SET signer_tenant_id = tenant_id WHERE signer_tenant_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_approvals_subject_status
  ON approvals (tenant_id, subject_type, subject_id, status);

COMMIT;
