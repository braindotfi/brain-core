/**
 * P1.3 — named TS mirror of BrainAuditAnchor.sol::verifyInclusion (lines 101–113).
 *
 * Location note: the prompt suggested shared/src/audit/verify.ts, but the
 * contract-identical hash is keccak256 — which is NOT in node:crypto (that
 * exposes NIST SHA3-256, a different function) and comes from viem. viem lives
 * in services/audit (the layer that owns the Merkle/anchor logic), not the base
 * @brain/shared package. Adding viem to the base package, or hand-rolling keccak
 * in shared, would be worse than reusing the single canonical implementation. So
 * the mirror lives here and is exported from @brain/audit.
 *
 * Scheme (identical to the contract and services/audit/merkle.ts):
 *   leaf      = keccak256(0x00 ++ leaf)
 *   internal  = keccak256(0x01 ++ sort(computed, sibling))   (lexicographic)
 */

import { verifyProof } from "./merkle.js";

/**
 * True iff `proof` proves `leaf` is included under `root`. Byte-identical to the
 * on-chain BrainAuditAnchor.verifyInclusion, so an off-chain proof verifies
 * on-chain without translation.
 */
export function verifyInclusion(root: Buffer, leaf: Buffer, proof: ReadonlyArray<Buffer>): boolean {
  return verifyProof(root, leaf, proof);
}
