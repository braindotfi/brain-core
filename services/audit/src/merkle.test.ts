import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { keccak256 } from "viem";
import { buildTree, hashInternalKeccak, hashLeafKeccak, makeProof, verifyProof } from "./merkle.js";

// Independent reference implementation of the BrainAuditAnchor.verifyInclusion
// scheme — leaf = keccak256(0x00 || leaf), internal = keccak256(0x01 || sort(a,b)).
// Written separately from merkle.ts's loop so it cross-checks the algorithm.
function k(bytes: Uint8Array): Buffer {
  return Buffer.from(keccak256(bytes, "bytes"));
}
function refLeaf(leaf: Buffer): Buffer {
  return k(Buffer.concat([Buffer.from([0x00]), leaf]));
}
function refNode(a: Buffer, b: Buffer): Buffer {
  const [lo, hi] = Buffer.compare(a, b) <= 0 ? [a, b] : [b, a];
  return k(Buffer.concat([Buffer.from([0x01]), lo, hi]));
}

describe("hash primitive is genuine keccak256 (not sha256)", () => {
  it("matches the published keccak256('') vector", () => {
    // keccak256 of empty input. sha256('') would be e3b0c442... — this guards
    // against silently reverting to the old sha256 default.
    expect(keccak256(new Uint8Array(0))).toBe(
      "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
    );
  });
});

describe("matches BrainAuditAnchor.verifyInclusion scheme", () => {
  it("leaf node is keccak256(0x00 || leaf)", () => {
    const leaf = Buffer.from("aa".repeat(32), "hex");
    expect(Buffer.compare(hashLeafKeccak(leaf), refLeaf(leaf))).toBe(0);
  });
  it("internal node is keccak256(0x01 || sort(a,b))", () => {
    const a = Buffer.from("11".repeat(32), "hex");
    const b = Buffer.from("22".repeat(32), "hex");
    expect(Buffer.compare(hashInternalKeccak(a, b), refNode(a, b))).toBe(0);
    // order-independent
    expect(Buffer.compare(hashInternalKeccak(a, b), hashInternalKeccak(b, a))).toBe(0);
  });
  it("a 4-leaf root equals the contract's bottom-up keccak fold", () => {
    const l = [0, 1, 2, 3].map((n) =>
      Buffer.from(
        String(n + 1)
          .padStart(2, "0")
          .repeat(32),
        "hex",
      ),
    );
    const expected = refNode(
      refNode(refLeaf(l[0]!), refLeaf(l[1]!)),
      refNode(refLeaf(l[2]!), refLeaf(l[3]!)),
    );
    expect(Buffer.compare(buildTree(l).root, expected)).toBe(0);
  });
});

describe("empty tree", () => {
  it("has a 32-byte zero root", () => {
    const t = buildTree([]);
    expect(t.root.length).toBe(32);
    expect(t.root.every((b) => b === 0)).toBe(true);
  });
});

describe("single-leaf tree", () => {
  it("root is the keccak leaf hash (not the raw leaf); empty proof validates", () => {
    const leaf = Buffer.from("aa".repeat(32), "hex");
    const t = buildTree([leaf]);
    expect(Buffer.compare(t.root, hashLeafKeccak(leaf))).toBe(0);
    expect(Buffer.compare(t.root, leaf)).not.toBe(0);
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
