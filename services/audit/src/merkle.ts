/**
 * Merkle tree builder + inclusion proof generator.
 *
 * The hashing scheme matches BrainAuditAnchor.sol::verifyInclusion EXACTLY so a
 * proof generated here verifies on-chain without translation:
 *   - leaf node     = keccak256(0x00 || leaf_data)
 *   - internal node = keccak256(0x01 || sort(left, right))   (lexicographic sort)
 *
 * Every tree carries a synthetic COUNT LEAF at index 0:
 *   countLeaf(n) = keccak256(keccak256("brain.audit.leaf-count.v1") || uint256be(n))
 *
 * Without it the root proved membership but not COMPLETENESS: an odd trailing
 * node is duplicated, so [A,B,C] and [A,B,C,C] hash to the same root and an
 * anchor claiming eventCount = 4 over a 3-event window was indistinguishable on
 * chain from a genuine 4-leaf window. With it, a verifier that rebuilds the tree
 * from the events actually in the window derives a different root whenever the
 * published count is a lie. Mirrored by BrainAuditAnchor.countLeaf, so the
 * synthetic leaf can be reconstructed on-chain from the stored eventCount and
 * checked against the root with verifyInclusion.
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

/** Domain tag of the synthetic count leaf. Mirrors BrainAuditAnchor's constant. */
const COUNT_LEAF_DOMAIN: Buffer = Buffer.from(
  keccak256(Buffer.from("brain.audit.leaf-count.v1", "utf8"), "bytes"),
);

/**
 * The synthetic leaf that binds a tree to its leaf count. It occupies index 0 of
 * every non-empty tree, so real event leaves start at index 1. Byte-identical to
 * BrainAuditAnchor.countLeaf(uint256).
 */
export function countLeaf(leafCount: number): Buffer {
  const word = Buffer.alloc(32);
  word.writeBigUInt64BE(BigInt(leafCount), 24);
  return Buffer.from(keccak256(Buffer.concat([COUNT_LEAF_DOMAIN, word]), "bytes"));
}

/** Internal node hash: keccak256(0x01 || min(a,b) || max(a,b)). */
export function hashInternalKeccak(a: Buffer, b: Buffer): Buffer {
  const [lo, hi] = Buffer.compare(a, b) <= 0 ? [a, b] : [b, a];
  return Buffer.from(keccak256(Buffer.concat([Buffer.from([0x01]), lo, hi]), "bytes"));
}

export interface MerkleTree {
  root: Buffer;
  /** Number of REAL event leaves, excluding the synthetic count leaf. */
  leafCount: number;
  /**
   * layers[0] is the leaf-node layer (already keccak-leaf-hashed). Its element 0
   * is the count leaf; event leaf `i` sits at layers[0][i + 1].
   */
  layers: Buffer[][];
}

export function buildTree(leaves: ReadonlyArray<Buffer>): MerkleTree {
  if (leaves.length === 0) {
    // Canonical empty-tree root — a 32-byte zero.
    return { root: Buffer.alloc(32), leafCount: 0, layers: [] };
  }
  // Index 0 is the count leaf; every real leaf shifts up by one.
  const nodes: Buffer[] = [countLeaf(leaves.length), ...leaves];
  const layers: Buffer[][] = [nodes.map((l) => hashLeafKeccak(l))];
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

/**
 * Inclusion proof for event leaf `leafIndex` (0-based over the REAL leaves; the
 * count leaf offset is applied here so callers never see it).
 */
export function makeProof(tree: MerkleTree, leafIndex: number): Buffer[] {
  return proofForNode(tree, leafIndex + 1);
}

/**
 * Inclusion proof for the synthetic count leaf, so a third party can prove that
 * a published root commits to the eventCount recorded beside it on-chain.
 */
export function makeCountProof(tree: MerkleTree): Buffer[] {
  return proofForNode(tree, 0);
}

function proofForNode(tree: MerkleTree, nodeIndex: number): Buffer[] {
  if (tree.layers.length === 0) return [];
  const proof: Buffer[] = [];
  let idx = nodeIndex;
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
