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
  /**
   * When true, policy activation rejects on ANY lintPolicy ERROR finding, not
   * only the confidence-floor codes (auto_no_amount_cap,
   * auto_no_counterparty_constraint, auto_no_verified_counterparty,
   * no_approval_path_high_value, unsupported_currency, invalid_approval_role,
   * auto_no_risk_bound, broad_any_auto). This is the emergency rollback
   * switch for that enforcement, independent of confidenceFloorReject, so
   * either can be flipped without the other. A production tenant enforces
   * regardless of this flag (see routes.ts sign handler). Sourced from
   * BRAIN_POLICY_LINT_REJECT, default true (fail closed).
   *
   * TODO(main.ts wiring): this field is not yet threaded through composition.
   * Add, next to the existing `confidenceFloorReject: cfg.BRAIN_POLICY_CONFIDENCE_FLOOR_REJECT,`
   * line in services/api/src/main.ts (around line 727):
   *   lintReject: cfg.BRAIN_POLICY_LINT_REJECT,
   * Left undone here because another agent holds main.ts in this change set.
   */
  lintReject?: boolean;
}
