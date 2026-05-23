/**
 * Merkle tree builder + inclusion proof generator.
 *
 * The hashing scheme matches BrainAuditAnchor.sol::verifyInclusion EXACTLY so a
 * proof generated here verifies on-chain without translation:
 *   - leaf node     = keccak256(0x00 || leaf_data)
 *   - internal node = keccak256(0x01 || sort(left, right))   (lexicographic sort)
 *
 * keccak256 is the only hash used — there is no pluggable/defaulted hash
 * function, by design: a sha256 default previously made off-chain roots
 * unverifiable on-chain. keccak256 comes from viem (already an audit dep, used
 * by the anchor broadcaster); it is byte-identical to the contract's keccak256.
 *
 * Property tested in merkle.test.ts (every leaf verifies) and cross-checked
 * against the contract scheme there and in contracts/test/BrainAuditAnchor.t.sol.
 */

import { keccak256 } from "viem";

/** Leaf node hash: keccak256(0x00 || leaf). */
export function hashLeafKeccak(leaf: Buffer): Buffer {
  return Buffer.from(keccak256(Buffer.concat([Buffer.from([0x00]), leaf]), "bytes"));
}

/** Internal node hash: keccak256(0x01 || min(a,b) || max(a,b)). */
export function hashInternalKeccak(a: Buffer, b: Buffer): Buffer {
  const [lo, hi] = Buffer.compare(a, b) <= 0 ? [a, b] : [b, a];
  return Buffer.from(keccak256(Buffer.concat([Buffer.from([0x01]), lo, hi]), "bytes"));
}

export interface MerkleTree {
  root: Buffer;
  leafCount: number;
  /** layers[0] is the leaf-node layer (already keccak-leaf-hashed). */
  layers: Buffer[][];
}

export function buildTree(leaves: ReadonlyArray<Buffer>): MerkleTree {
  if (leaves.length === 0) {
    // Canonical empty-tree root — a 32-byte zero.
    return { root: Buffer.alloc(32), leafCount: 0, layers: [] };
  }
  const layers: Buffer[][] = [leaves.map((l) => hashLeafKeccak(l))];
  while (layers[layers.length - 1]!.length > 1) {
    const prev = layers[layers.length - 1]!;
    const next: Buffer[] = [];
    for (let i = 0; i < prev.length; i += 2) {
      const a = prev[i]!;
      const b = i + 1 < prev.length ? prev[i + 1]! : a; // duplicate odd node up
      next.push(hashInternalKeccak(a, b));
    }
    layers.push(next);
  }
  return {
    root: layers[layers.length - 1]![0]!,
    leafCount: leaves.length,
    layers,
  };
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

export function verifyProof(root: Buffer, leaf: Buffer, proof: ReadonlyArray<Buffer>): boolean {
  let computed: Buffer = hashLeafKeccak(leaf);
  for (const sibling of proof) {
    computed = hashInternalKeccak(computed, sibling);
  }
  return Buffer.compare(computed, root) === 0;
}
