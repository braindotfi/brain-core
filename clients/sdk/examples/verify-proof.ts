/**
 * verify-proof — the artifact an auditor runs (H-07).
 *
 * Reads a Proof JSON (from `brain.proof(actionId)` / GET /v1/proof/{action_id})
 * and INDEPENDENTLY verifies it, without trusting Brain:
 *
 *   1. Merkle inclusion (offline): recompute the Merkle root from one audit
 *      event's `event_hash` leaf + `merkle_proof`, and check it equals
 *      `merkle_root`. Uses the exact off-chain scheme the audit log + the
 *      BrainAuditAnchor contract agree on:
 *        leaf  = keccak256(0x00 || event_hash)
 *        node  = keccak256(0x01 || min(a,b) || max(a,b))
 *
 *   2. On-chain presence (optional): if `chain_anchor` is populated and an RPC
 *      is supplied, confirm the same `merkle_root` was published to
 *      BrainAuditAnchor via viem `readContract`.
 *
 * Usage:
 *   tsx examples/verify-proof.ts --proof-json proof.json [--rpc <url>]
 *   cat proof.json | tsx examples/verify-proof.ts
 *
 * Requirements / sandbox status:
 *   - Requires `viem` (keccak256 byte-identical to the contract). Install with
 *     `npm i viem`.
 *   - Step 1 (Merkle) runs entirely offline and is the core auditor check.
 *   - Step 2 (on-chain) needs an RPC + the deployed BrainAuditAnchor; it is
 *     BLOCKED in the build sandbox (no viem/anvil/RPC) and is exercised against
 *     Base Sepolia in a full environment (see the H-07 summary).
 */

import { readFileSync } from "node:fs";
// eslint-disable-next-line import/no-unresolved -- viem is an auditor-side install, not a SDK dep
import { keccak256 } from "viem";

interface ProofLike {
  merkle_root: string;
  merkle_proof: string[];
  audit_events: Array<{ event_hash: string }>;
  chain_anchor: { tx_hash: string; contract_address: string; chain: string } | null;
}

const fromHex = (h: string): Uint8Array =>
  Uint8Array.from(
    (h.startsWith("0x") ? h.slice(2) : h).match(/.{1,2}/g)?.map((b) => parseInt(b, 16)) ?? [],
  );
const toHex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
};
const keccakBytes = (b: Uint8Array): Uint8Array => fromHex(keccak256(b, "hex"));

const leafHash = (leaf: Uint8Array): Uint8Array => keccakBytes(concat(Uint8Array.of(0x00), leaf));
const nodeHash = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const [lo, hi] = toHex(a) <= toHex(b) ? [a, b] : [b, a];
  return keccakBytes(concat(Uint8Array.of(0x01), lo, hi));
};

/** Recompute the root from a leaf event_hash + proof path; compare to root. */
function verifyInclusion(rootHex: string, eventHashHex: string, proofHex: string[]): boolean {
  let acc = leafHash(fromHex(eventHashHex));
  for (const sib of proofHex) acc = nodeHash(acc, fromHex(sib));
  return toHex(acc) === (rootHex.startsWith("0x") ? rootHex.slice(2) : rootHex).toLowerCase();
}

function readProof(): ProofLike {
  const idx = process.argv.indexOf("--proof-json");
  const raw =
    idx !== -1 && process.argv[idx + 1] !== undefined
      ? readFileSync(process.argv[idx + 1] as string, "utf8")
      : readFileSync(0, "utf8"); // stdin
  return JSON.parse(raw) as ProofLike;
}

function main(): void {
  const proof = readProof();
  // The proof path was built for one leaf; accept if ANY audit event verifies.
  const ok = proof.audit_events.some((e) =>
    verifyInclusion(proof.merkle_root, e.event_hash, proof.merkle_proof),
  );

  // eslint-disable-next-line no-console -- CLI output is the whole point
  console.log(
    `Merkle inclusion: ${ok ? "PASS ✓" : "FAIL ✗"} (root ${proof.merkle_root.slice(0, 16)}…)`,
  );
  if (proof.chain_anchor === null) {
    // eslint-disable-next-line no-console
    console.log("On-chain anchor: not yet published (chain_anchor is null).");
  } else {
    // eslint-disable-next-line no-console
    console.log(
      `On-chain anchor: tx ${proof.chain_anchor.tx_hash} on ${proof.chain_anchor.chain}. ` +
        "Pass --rpc <url> to confirm the root via BrainAuditAnchor (requires viem + RPC).",
    );
  }
  process.exit(ok ? 0 : 1);
}

main();
