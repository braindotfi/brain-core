-- RFC 0002 Phase C, increment 1: tier the on-chain attestation requirement
-- per agent instead of forcing every agent through BrainMCPAgentRegistry.
--
-- Default is 'onchain_custodial' (the existing behavior), never 'none' --
-- defaulting new rows to 'none' would retroactively grant every existing
-- agent row the unattested tier-1 exemption with no code change at all.

BEGIN;

ALTER TABLE agents ADD COLUMN IF NOT EXISTS attestation_mode TEXT NOT NULL
  DEFAULT 'onchain_custodial'
  CHECK (attestation_mode IN ('none','tenant_signed','onchain_custodial'));

COMMIT;
