-- RFC 0002 Phase C, increment 4: tier 2 (tenant_signed) attestation storage.
--
-- The EIP-712 AgentRegistration digest covers agentId, which the server
-- mints, so the tenant cannot sign before the agent row exists.
-- Registration is therefore two steps: POST /agents creates the row
-- pending_onchain and returns the typed-data payload to sign;
-- POST /agents/{id}/attestation verifies the returned signature recovers to
-- the tenant's designated on-chain signer (tenants.onchain_signer_address)
-- BEFORE storing it here, then the existing agent-registration-worker.ts
-- picks the row up exactly like an onchain_custodial row.
--
-- tenant_signer_address is stored alongside the signature (denormalized
-- from tenants.onchain_signer_address at verification time) rather than
-- re-read at confirm time, so a later signer-designation change can never
-- silently reattach a stale signature to a new signer.

BEGIN;

ALTER TABLE agents ADD COLUMN IF NOT EXISTS tenant_signer_address TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS tenant_signature TEXT;

COMMIT;
