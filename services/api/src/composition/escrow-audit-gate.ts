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
import {
  deployedRuntimeMatches,
  evaluateApproval,
  isChainApproved,
  isValidImmutableRefs,
  parseAuditStatus,
} from "@brain/shared";

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
export function readAuditStatusDoc(startDir: string = process.cwd()): unknown {
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
    // Once a file is found at a level it is THE record (we do not walk up past a
    // malformed file to a stale ancestor). parseAuditStatus is fail-soft: a
    // malformed file yields null, which every downstream check treats as not
    // approved.
    return parseAuditStatus(raw).doc;
  }
  return null;
}

export function readAuditStatusApproved(startDir: string = process.cwd()): boolean {
  return evaluateApproval(readAuditStatusDoc(startDir)).approved;
}

/**
 * Whether the committed audit record authorizes escrow on `chainId` — i.e. the
 * chain is listed in the record's `approved_chain_ids`. Uses the same shared
 * validator the CI guard / readiness aggregator use, so an approval scoped to
 * Base mainnet cannot be stretched to a different chain. Fail-closed: a missing,
 * malformed, or chain-omitting record yields `false`.
 */
export function readAuditChainApproved(chainId: number, startDir: string = process.cwd()): boolean {
  return isChainApproved(readAuditStatusDoc(startDir), chainId);
}

/**
 * The committed deployed-bytecode expectation: the audited (immutable-masked)
 * runtime bytecode hash and the immutable byte ranges to mask. Read from
 * contracts/audit-status.json so the runtime fence can verify the on-chain code
 * without the Foundry artifact (the image ships dist/, not contracts/out/).
 */
export function readDeployedBytecodeExpectation(startDir: string = process.cwd()): {
  expectedRuntimeSha256: string | undefined;
  immutableReferences: unknown;
} {
  const doc = readAuditStatusDoc(startDir);
  if (typeof doc !== "object" || doc === null) {
    return { expectedRuntimeSha256: undefined, immutableReferences: undefined };
  }
  const record = doc as Record<string, unknown>;
  const sha = record["runtime_bytecode_sha256"];
  return {
    expectedRuntimeSha256: typeof sha === "string" ? sha : undefined,
    immutableReferences: record["immutable_references"],
  };
}

export interface DeployedBytecodeGateInput {
  /** cfg.BRAIN_BASE_CHAIN_ID. */
  chainId: number;
  /** cfg.BRAIN_ESCROW_ADDRESS — undefined ⇒ EscrowBaseRail not configured. */
  escrowAddress: string | undefined;
  /** audit-status.json runtime_bytecode_sha256 (immutable-masked). */
  expectedRuntimeSha256: string | undefined;
  /** audit-status.json immutable_references (validated here). */
  immutableReferences: unknown;
  /** eth_getCode seam: resolves the deployed bytecode hex ("0x..") for an address. */
  getCode: (address: string) => Promise<string>;
}

/**
 * On Base mainnet, with an escrow address configured, verify the DEPLOYED escrow
 * bytecode matches the audited runtime bytecode (immutable-masked) via
 * `eth_getCode`. Throws on any mismatch so a wrong / unaudited / tampered
 * deployment becomes a CrashLoopBackoff rather than a silent funds-custody risk.
 *
 * Silent on non-mainnet chains and when no escrow address is set. Mainnet escrow
 * is ALSO gated by assertEscrowAuditApproved (the committed-approved + chain +
 * env checks) — this is the on-chain half: "and the code on-chain is the code we
 * audited". Async because eth_getCode is a network read.
 *
 * Fail-closed: if the committed record lacks the runtime hash or immutable
 * ranges, we cannot verify, so we refuse to boot.
 */
export async function assertDeployedEscrowBytecode(
  input: DeployedBytecodeGateInput,
): Promise<void> {
  if (input.chainId !== BASE_MAINNET_CHAIN_ID) return;
  if (input.escrowAddress === undefined) return;

  const expected = input.expectedRuntimeSha256;
  const refs = input.immutableReferences;
  if (expected === undefined || !isValidImmutableRefs(refs)) {
    throw new Error(
      "BRAIN_ESCROW_ADDRESS is set on Base mainnet but contracts/audit-status.json is missing " +
        "runtime_bytecode_sha256 or a valid immutable_references list; cannot verify the deployed " +
        "escrow bytecode against the audited build. Refusing to start.",
    );
  }

  const deployed = await input.getCode(input.escrowAddress);
  const result = deployedRuntimeMatches(deployed, expected, refs);
  if (!result.match) {
    throw new Error(
      `Deployed escrow bytecode at ${input.escrowAddress} (Base mainnet) does NOT match the audited ` +
        `runtime bytecode: ${result.reason ?? "mismatch"}. The on-chain contract is not the audited ` +
        "build. Refusing to start.",
    );
  }
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
  /**
   * Whether the committed audit record's `approved_chain_ids` lists `chainId`
   * (P1 build binding). An audit approved for one chain must not authorize
   * escrow on another, so mainnet escrow boot ALSO requires the audited chain
   * set to include Base mainnet. Compute at the call site via
   * `readAuditChainApproved(chainId)`.
   */
  auditChainApproved: boolean;
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
  if (input.auditStatusApproved && input.auditChainApproved && hasEnvAttestation) return;
  const missing: string[] = [];
  if (!input.auditStatusApproved) {
    missing.push('contracts/audit-status.json status is not "approved" (R-01: audit not complete)');
  }
  if (!input.auditChainApproved) {
    missing.push(
      `contracts/audit-status.json approved_chain_ids does not list this chain (${String(
        input.chainId,
      )}); the audit did not authorize escrow here`,
    );
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
