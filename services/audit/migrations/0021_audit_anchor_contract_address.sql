-- Record which contract an anchor was published to (root-cause fix, 2026-08-07).
--
-- AUDIT_ANCHOR_ADDRESS is a single scalar, and the proof path
-- (services/api/src/proof/fetchProofSources.ts) paired each row's HISTORICAL
-- tx hash with the CURRENT configured address. After the 2026-08-06 contract
-- rotation that made every historical proof bundle claim a transaction on the
-- old contract had been published to the new one. A third party verifying
-- against the address we handed them gets a negative result and has every
-- reason to conclude the audit trail is fabricated. That is not a degraded
-- proof, it is an incorrect one.
--
-- The durable fix is to stop guessing: the row records the contract it was
-- actually published to, so the proof path reads it instead of inferring it
-- from current configuration. Configuration drifts; a written column does not.
--
-- Backfill is deterministic from the block number, because the rotation has a
-- known deploy block. Rows with no on-chain block (pending/reverted) are left
-- NULL: they were never published to anything.
--
-- The addresses below are the Base Sepolia deployments. Environments that
-- never anchored (staging, per the shared-publisher conflict) have no rows
-- with a block number, so this backfill is a no-op there rather than wrong.

BEGIN;

ALTER TABLE audit_anchors
  ADD COLUMN IF NOT EXISTS onchain_contract_address TEXT;

-- FORCE ROW LEVEL SECURITY is on audit_anchors, so under a non-superuser
-- migration role this UPDATE would be scoped by tenant_isolation's
-- USING (tenant_id = current_setting('app.tenant_id', true)) -- unset during a
-- migration, so the predicate is NULL and the UPDATE would silently touch zero
-- rows and still report success. docker-compose.prod.yml runs `migrate` as the
-- superuser `brain`, which bypasses RLS, but this must not depend on that.
SET LOCAL row_security = off;

UPDATE audit_anchors
   SET onchain_contract_address = '0xb900add824064098342c869ff83efdeb05eb95ce'
 WHERE onchain_contract_address IS NULL
   AND onchain_block_number IS NOT NULL
   AND onchain_block_number < 45077782;

UPDATE audit_anchors
   SET onchain_contract_address = '0xaB0EAc4Aef3318c94EaFe3027D6ee12ca21ae97A'
 WHERE onchain_contract_address IS NULL
   AND onchain_block_number IS NOT NULL
   AND onchain_block_number >= 45077782;

COMMIT;
