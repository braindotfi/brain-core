-- Brain approvals table.
-- Source of truth: Brain_MVP_Architecture.md §3 Layer 5 + Engineering
-- Standards §6 (pre-execution gate) and §9.5 (PaymentIntent state machine).
--
-- A row records that a specific principal signed an approval for a
-- specific subject (PaymentIntent or Proposal). Quorum is determined by
-- counting unique (subject, approver_role) pairs against the policy's
-- required_approvers list.

BEGIN;

CREATE TABLE IF NOT EXISTS approvals (
  id                     TEXT        PRIMARY KEY,                  -- appr_<ulid>
  tenant_id              TEXT        NOT NULL,
  subject_type           TEXT        NOT NULL
                           CHECK (subject_type IN ('payment_intent','proposal')),
  subject_id             TEXT        NOT NULL,
  approver_principal_id  TEXT        NOT NULL,                     -- user_<ulid> | agent_<ulid>
  approver_role          TEXT,                                     -- e.g. cfo, ceo
  signed_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  signature              TEXT,                                     -- EIP-712 signature for high-value
  -- One signature per (subject, approver). Re-signing is a no-op.
  UNIQUE (tenant_id, subject_type, subject_id, approver_principal_id)
);

CREATE INDEX IF NOT EXISTS idx_approvals_tenant_subject
  ON approvals (tenant_id, subject_type, subject_id);

CREATE INDEX IF NOT EXISTS idx_approvals_tenant_signer
  ON approvals (tenant_id, approver_principal_id);

ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON approvals
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON approvals
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

COMMIT;
