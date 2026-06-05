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

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const BASE_MAINNET_CHAIN_ID = 8453;

/**
 * Resolve and read contracts/audit-status.json, returning whether its status is
 * "approved". Walks up from `startDir` (default process.cwd()) so it works
 * whether the api is launched from the repo root or from services/api.
 *
 * Fail-closed: a missing file, a parse error, or any status other than
 * "approved" yields `false`. A mainnet-escrow deploy must therefore SHIP the
 * committed, audit-derived contracts/audit-status.json (status "approved") into
 * the image, or this fence keeps the api from booting. check-audit-status.mjs
 * guarantees the file cannot say "approved" without real audit evidence.
 */
export function readAuditStatusApproved(startDir: string = process.cwd()): boolean {
  let dir = startDir;
  for (let i = 0; i < 16; i += 1) {
    try {
      const raw = readFileSync(join(dir, "contracts", "audit-status.json"), "utf8");
      return (JSON.parse(raw) as { status?: unknown }).status === "approved";
    } catch {
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return false;
}

export interface EscrowAuditGateInput {
  /** cfg.BRAIN_BASE_CHAIN_ID. */
  chainId: number;
  /** cfg.BRAIN_ESCROW_ADDRESS — undefined ⇒ EscrowBaseRail not configured. */
  escrowAddress: string | undefined;
  /** cfg.BRAIN_ESCROW_AUDIT_APPROVED — defaults to "false". Legacy boolean. */
  auditApproved: "true" | "false";
  /**
   * cfg.BRAIN_ESCROW_AUDIT_RECEIPT — non-empty URL/filepath/hash pointing
   * at the audit report. Preferred over the legacy boolean because it
   * carries diligence metadata (which report? which audited commit?).
   * Either signal satisfies the operator-attestation half of the fence.
   */
  auditReceipt?: string;
  /**
   * Whether contracts/audit-status.json — the committed, reviewed source of
   * truth for the external audit (R-01) — has status "approved". The env
   * attestation above is NOT sufficient on its own: a bare env flag could be
   * flipped to bypass a pending audit, so mainnet escrow ALSO requires the
   * committed record to say approved (and check-audit-status.mjs forbids
   * marking it approved without an auditor, audited commit, report, and zero
   * open critical/high findings). Read from the file at the call site.
   */
  auditStatusApproved: boolean;
}

/**
 * Throws when the configured escrow address would be wired against Base
 * mainnet without an explicit audit attestation. Silent on all non-mainnet
 * chains, and silent on mainnet when no escrow address is set.
 *
 * Mainnet boot requires BOTH halves:
 *   1. the committed audit record — contracts/audit-status.json status
 *      "approved" (input.auditStatusApproved) — which check-audit-status.mjs
 *      will not let you set without an auditor, audited commit, report, and
 *      zero open critical/high findings; AND
 *   2. an operator attestation in the environment, satisfied by EITHER
 *      `BRAIN_ESCROW_AUDIT_RECEIPT` (preferred — names what was audited) OR
 *      `BRAIN_ESCROW_AUDIT_APPROVED="true"` (legacy bare-boolean).
 *
 * Requiring both means a bare env flag can no longer bypass a pending audit:
 * the reviewed, committed file must also say approved.
 */
export function assertEscrowAuditApproved(input: EscrowAuditGateInput): void {
  if (input.chainId !== BASE_MAINNET_CHAIN_ID) return;
  if (input.escrowAddress === undefined) return;
  const hasReceipt = typeof input.auditReceipt === "string" && input.auditReceipt.length > 0;
  const hasEnvAttestation = input.auditApproved === "true" || hasReceipt;
  if (input.auditStatusApproved && hasEnvAttestation) return;
  const missing: string[] = [];
  if (!input.auditStatusApproved) {
    missing.push('contracts/audit-status.json status is not "approved" (R-01: audit not complete)');
  }
  if (!hasEnvAttestation) {
    missing.push(
      'neither BRAIN_ESCROW_AUDIT_RECEIPT nor BRAIN_ESCROW_AUDIT_APPROVED="true" is set',
    );
  }
  throw new Error(
    `BRAIN_ESCROW_ADDRESS is set on Base mainnet (chainId=${String(
      BASE_MAINNET_CHAIN_ID,
    )}) but mainnet escrow boot is not cleared: ${missing.join("; ")}. The external ` +
      "smart-contract audit (R-01) must complete, contracts/audit-status.json must be " +
      'updated to status "approved" from the final report, and the operator must set ' +
      'BRAIN_ESCROW_AUDIT_RECEIPT (preferred) or BRAIN_ESCROW_AUDIT_APPROVED="true". ' +
      "Refusing to start so the orchestrator surfaces the misconfiguration.",
  );
}
