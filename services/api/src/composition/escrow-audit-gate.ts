/**
 * Production fence for unaudited escrow on Base mainnet.
 *
 * The external smart-contract audit (Task #37) is the gating dependency for
 * mainnet promotion. Until that audit signs off, the api refuses to boot when:
 *   chainId === 8453               (Base mainnet)
 *   AND BRAIN_ESCROW_ADDRESS set   (EscrowBaseRail would register)
 *   AND BRAIN_ESCROW_AUDIT_APPROVED !== "true"
 *
 * On Base Sepolia (84_532) the fence is silent: the testnet escrow address is
 * already deployed and used in dev/staging.
 *
 * Why a boot fence (not just a runtime check at dispatch):
 *   - Symmetry with assertDbIsolationFences / AES-GCM in-prod fence /
 *     BRAIN_AGENTS_INBOUND_SECRET fence: misconfiguration becomes a
 *     CrashLoopBackoff, not a quiet 500 wave.
 *   - The §6 gate cannot detect "operator forgot to flip the audit flag" —
 *     that's a process problem, not a transactional one.
 *
 * Factored out of main.ts so the behavior is unit-testable without booting
 * the full server.
 */

const BASE_MAINNET_CHAIN_ID = 8453;

export interface EscrowAuditGateInput {
  /** cfg.BRAIN_BASE_CHAIN_ID. */
  chainId: number;
  /** cfg.BRAIN_ESCROW_ADDRESS — undefined ⇒ EscrowBaseRail not configured. */
  escrowAddress: string | undefined;
  /** cfg.BRAIN_ESCROW_AUDIT_APPROVED — defaults to "false". */
  auditApproved: "true" | "false";
}

/**
 * Throws when the configured escrow address would be wired against Base
 * mainnet without an explicit audit-approved attestation. Silent on all
 * non-mainnet chains, and silent on mainnet when no escrow address is set.
 */
export function assertEscrowAuditApproved(input: EscrowAuditGateInput): void {
  if (input.chainId !== BASE_MAINNET_CHAIN_ID) return;
  if (input.escrowAddress === undefined) return;
  if (input.auditApproved === "true") return;
  throw new Error(
    `BRAIN_ESCROW_ADDRESS is set on Base mainnet (chainId=${String(
      BASE_MAINNET_CHAIN_ID,
    )}) but BRAIN_ESCROW_AUDIT_APPROVED is not "true". The external ` +
      "smart-contract audit (Task #37) must complete and the audited bytecode " +
      "must be the deployed contract before the api will boot against mainnet. " +
      "Refusing to start so the orchestrator surfaces the misconfiguration.",
  );
}
