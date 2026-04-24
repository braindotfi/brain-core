import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { buildTree, makeProof, verifyProof } from "./merkle.js";

describe("empty tree", () => {
  it("has a 32-byte zero root", () => {
    const t = buildTree([]);
    expect(t.root.length).toBe(32);
    expect(t.root.every((b) => b === 0)).toBe(true);
  });
});

describe("single-leaf tree", () => {
  it("root equals the leaf; empty proof validates", () => {
    const leaf = Buffer.from("aa".repeat(32), "hex");
    const t = buildTree([leaf]);
    expect(Buffer.compare(t.root, leaf)).toBe(0);
    expect(verifyProof(t.root, leaf, [])).toBe(true);
  });
});

describe("pair tree", () => {
  it("verifies both leaves against the root", () => {
    const a = Buffer.from("aa".repeat(32), "hex");
    const b = Buffer.from("bb".repeat(32), "hex");
    const t = buildTree([a, b]);
    expect(verifyProof(t.root, a, makeProof(t, 0))).toBe(true);
    expect(verifyProof(t.root, b, makeProof(t, 1))).toBe(true);
  });
});

describe("odd leaf count", () => {
  it("duplicates the last leaf up the tree but still proves correctly", () => {
    const leaves = [
      Buffer.from("01".repeat(32), "hex"),
      Buffer.from("02".repeat(32), "hex"),
      Buffer.from("03".repeat(32), "hex"),
    ];
    const t = buildTree(leaves);
    for (let i = 0; i < leaves.length; i += 1) {
      expect(verifyProof(t.root, leaves[i]!, makeProof(t, i))).toBe(true);
    }
  });
});

describe("property: every leaf has a valid proof", () => {
  it("holds for random leaf sets up to 32", () => {
    fc.assert(
      fc.property(
        fc.array(fc.uint8Array({ minLength: 32, maxLength: 32 }), {
          minLength: 1,
          maxLength: 32,
        }),
        (raw) => {
          const leaves = raw.map((u) => Buffer.from(u));
          const t = buildTree(leaves);
          for (let i = 0; i < leaves.length; i += 1) {
            const p = makeProof(t, i);
            expect(verifyProof(t.root, leaves[i]!, p)).toBe(true);
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});

describe("property: wrong proofs fail", () => {
  it("a modified leaf does not verify", () => {
    fc.assert(
      fc.property(
        fc.array(fc.uint8Array({ minLength: 32, maxLength: 32 }), {
          minLength: 2,
          maxLength: 16,
        }),
        (raw) => {
          const leaves = raw.map((u) => Buffer.from(u));
          const t = buildTree(leaves);
          const mutated = Buffer.from(leaves[0]!);
          mutated[0] = (mutated[0]! + 1) & 0xff;
          const p = makeProof(t, 0);
          expect(verifyProof(t.root, mutated, p)).toBe(false);
        },
      ),
    );
  });
});
