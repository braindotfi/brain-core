/**
 * P1.3 — property-based Merkle inclusion, mirroring
 * BrainAuditAnchor.sol::verifyInclusion (lines 101–113).
 *
 * For random sequences of 1..1000 event hashes: build the root, generate each
 * leaf's inclusion proof, and assert it verifies via verifyInclusion. Then
 * tamper one byte of the proof and one byte of the leaf and assert both fail.
 * The contract side is fuzzed in contracts/test/BrainAuditAnchor.t.sol.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildTree, makeProof } from "./merkle.js";
import { verifyInclusion } from "./verify.js";

describe("P1.3 — Merkle inclusion property (verifyInclusion mirror)", () => {
  it("every leaf in a 1..1000 set verifies; tampering the leaf or proof fails", () => {
    fc.assert(
      fc.property(
        fc.array(fc.uint8Array({ minLength: 32, maxLength: 32 }), {
          minLength: 1,
          maxLength: 1000,
        }),
        fc.nat(),
        (raw, pick) => {
          const leaves = raw.map((u) => Buffer.from(u));
          const tree = buildTree(leaves);
          const idx = pick % leaves.length;
          const proof = makeProof(tree, idx);

          // 1. A correct proof verifies.
          expect(verifyInclusion(tree.root, leaves[idx]!, proof)).toBe(true);

          // 2. Tampering one byte of the leaf breaks verification.
          const badLeaf = Buffer.from(leaves[idx]!);
          badLeaf[0] = (badLeaf[0]! + 1) & 0xff;
          expect(verifyInclusion(tree.root, badLeaf, proof)).toBe(false);

          // 3. Tampering one byte of the proof breaks verification (when there
          //    is a proof — a single-leaf tree has an empty proof).
          if (proof.length > 0) {
            const badProof = proof.map((p) => Buffer.from(p));
            badProof[0]![0] = (badProof[0]![0]! + 1) & 0xff;
            expect(verifyInclusion(tree.root, leaves[idx]!, badProof)).toBe(false);
          }

          // 4. Tampering the root breaks verification.
          const badRoot = Buffer.from(tree.root);
          badRoot[0] = (badRoot[0]! + 1) & 0xff;
          expect(verifyInclusion(badRoot, leaves[idx]!, proof)).toBe(false);
        },
      ),
      { numRuns: 40 },
    );
  });
});
