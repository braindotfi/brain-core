import type { AuditEmitter } from "@brain/shared";
import type { Pool } from "pg";

export interface PolicyDeps {
  pool: Pool;
  audit: AuditEmitter;
  /** Base chain id (mainnet 8453, sepolia 84532) for EIP-712 payloads. */
  chainId: number;
  /** BrainPolicyRegistry contract address (populated from config). */
  policyRegistryAddress: `0x${string}`;
  /**
   * Returns true iff `address` is a pre-authorized signer for `tenantId`, per
   * the on-chain BrainPolicyRegistry per-tenant allowlist (`isTenantSigner`).
   * The /policy/:tenant_id/sign route counts only authorized, distinct signers
   * toward quorum — mirroring the on-chain `registerPolicy` guards
   * (`NotTenantSigner` / `DuplicateSigner`) so off-chain quorum cannot be forged
   * with self-generated keys. Must be fail-closed: return false when the
   * allowlist cannot be confirmed (e.g. RPC failure).
   */
  isAuthorizedSigner: (tenantId: string, address: string) => Promise<boolean>;
  /** When true, policy activation rejects missing or too-low confidence floors. */
  confidenceFloorReject?: boolean;
}
