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
import { evaluateApproval, parseAuditStatus } from "@brain/shared";

const BASE_MAINNET_CHAIN_ID = 8453;

/**
 * Resolve and read contracts/audit-status.json, returning whether the record
 * authorizes a mainnet escrow boot. Walks up from `startDir` (default
 * process.cwd()) so it works whether the api is launched from the repo root or
 * from services/api.
 *
 * The verdict is the shared `evaluateApproval` (from @brain/shared) — the SAME
 * canonical validator the CI guard (scripts/check-audit-status.mjs) and the
 * readiness aggregator use. So `approved` is NOT a bare `status === "approved"`
 * check: it additionally requires a non-empty auditor, a 40-hex audited commit,
 * a report reference, and zero unresolved critical/high findings. This closes
 * the fail-open where an out-of-band image build could ship an incomplete
 * record whose `status` happened to read "approved".
 *
 * Fail-closed: a missing file, a malformed file, or any incomplete/non-approved
 * record yields `false`. A mainnet-escrow deploy must therefore SHIP a
 * committed, fully-evidenced contracts/audit-status.json into the image, or
 * this fence keeps the api from booting. Once a file is found at a level it is
 * THE record (we do not keep walking up past a malformed file to a stale
 * ancestor) — read failure (ENOENT) is what advances to the parent.
 */
export function readAuditStatusApproved(startDir: string = process.cwd()): boolean {
  let dir = startDir;
  for (let i = 0; i < 16; i += 1) {
    let raw: string;
    try {
      raw = readFileSync(join(dir, "contracts", "audit-status.json"), "utf8");
    } catch {
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
      continue;
    }
    return evaluateApproval(parseAuditStatus(raw).doc).approved;
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
