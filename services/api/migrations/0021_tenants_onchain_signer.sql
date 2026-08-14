-- RFC 0002 Phase C, increment 4: tenant-designated on-chain signer.
--
-- Tier 2 (attestation_mode=tenant_signed) needs a way for a tenant to name
-- the address that will sign its own BrainMCPAgentRegistry attestations.
-- BrainMCPAgentRegistry._requireQuorum has no bootstrap branch, so this
-- address can only be SEATED on-chain through Brain's own initialAdmin
-- setTenantSigner bootstrap transaction (driven by
-- TenantSignedRegistrationRelayer's phase 1, services/execution/src/relayers
-- /tenant-signed.ts) -- this column is the OFF-CHAIN record of which
-- address the tenant has proven current control of (a fresh SIWX proof)
-- AND already linked to itself (wallet_identities), not yet an on-chain
-- fact by itself. See POST /v1/tenants/{id}/onchain-signer
-- (services/api/src/onboarding/onchain-signer.ts).
--
-- NULL means the tenant has not designated a signer: POST /agents with
-- attestation_mode=tenant_signed then rejects with
-- tenant_signer_not_designated, and onchain_custodial stays available.

BEGIN;

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS onchain_signer_address TEXT;

COMMENT ON COLUMN tenants.onchain_signer_address IS
  'Tenant-designated BrainMCPAgentRegistry signer address (RFC 0002 Phase C tier 2). Set only after a fresh SIWX proof over an address already linked in wallet_identities. NULL = no self-custody signer designated.';

COMMIT;
