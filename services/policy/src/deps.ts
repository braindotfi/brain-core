import type { AuditEmitter } from "@brain/api/shared";
import type { Pool } from "pg";

export interface PolicyDeps {
  pool: Pool;
  audit: AuditEmitter;
  /** Base chain id (mainnet 8453, sepolia 84532) for EIP-712 payloads. */
  chainId: number;
  /** BrainPolicyRegistry contract address (populated from config). */
  policyRegistryAddress: `0x${string}`;
}
