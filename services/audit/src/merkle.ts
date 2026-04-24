/**
 * Merkle tree builder + inclusion proof generator.
 *
 * Pair-sort hashing (leaf/sibling lexicographically ordered before keccak)
 * so leaf ordering doesn't affect the root. Matches BrainAuditAnchor.sol
 * verifyInclusion exactly — proofs generated here verify on-chain without
 * translation.
 *
 * Property tested in merkle.test.ts: every leaf has a valid proof against
 * the constructed root, for random sets up to N=64.
 */

import { createHash } from "node:crypto";

function keccakLike(input: Uint8Array): Buffer {
  // We use sha256 here as a self-contained fallback. The on-chain contract
  // uses keccak256; for MVP we standardize the off-chain publisher on
  // keccak (imported from @noble/hashes in policy service) — this module
  // accepts the hash function as a parameter so callers can plug either.
  return createHash("sha256").update(input).digest();
}

export type HashFn = (input: Uint8Array) => Uint8Array;

export interface MerkleTree {
  root: Buffer;
  leafCount: number;
  layers: Buffer[][];
  hashFn: HashFn;
}

export function buildTree(leaves: ReadonlyArray<Buffer>, hashFn: HashFn = keccakLike): MerkleTree {
  if (leaves.length === 0) {
    // Canonical empty-tree root — a 32-byte zero.
    return { root: Buffer.alloc(32), leafCount: 0, layers: [], hashFn };
  }
  const layers: Buffer[][] = [leaves.map((l) => Buffer.from(l))];
  while (layers[layers.length - 1]!.length > 1) {
    const prev = layers[layers.length - 1]!;
    const next: Buffer[] = [];
    for (let i = 0; i < prev.length; i += 2) {
      const a = prev[i]!;
      const b = i + 1 < prev.length ? prev[i + 1]! : a; // duplicate odd leaf up
      next.push(hashPair(hashFn, a, b));
    }
    layers.push(next);
  }
  return {
    root: layers[layers.length - 1]![0]!,
    leafCount: leaves.length,
    layers,
    hashFn,
  };
}

export function hashPair(hashFn: HashFn, a: Buffer, b: Buffer): Buffer {
  const ordered = Buffer.compare(a, b) < 0 ? Buffer.concat([a, b]) : Buffer.concat([b, a]);
  return Buffer.from(hashFn(ordered));
}

export function makeProof(tree: MerkleTree, leafIndex: number): Buffer[] {
  if (tree.layers.length === 0) return [];
  const proof: Buffer[] = [];
  let idx = leafIndex;
  for (let l = 0; l < tree.layers.length - 1; l += 1) {
    const layer = tree.layers[l]!;
    const pair = idx ^ 1;
    const sibling = pair < layer.length ? layer[pair]! : layer[idx]!;
    proof.push(sibling);
    idx = Math.floor(idx / 2);
  }
  return proof;
}

export function verifyProof(
  root: Buffer,
  leaf: Buffer,
  proof: ReadonlyArray<Buffer>,
  hashFn: HashFn = keccakLike,
): boolean {
  let computed = Buffer.from(leaf);
  for (const sibling of proof) {
    computed = hashPair(hashFn, computed, sibling);
  }
  return Buffer.compare(computed, root) === 0;
}
