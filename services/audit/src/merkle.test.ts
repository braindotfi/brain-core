import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { keccak256 } from "viem";
import {
  buildTree,
  countLeaf,
  hashInternalKeccak,
  hashLeafKeccak,
  makeCountProof,
  makeProof,
  verifyProof,
} from "./merkle.js";

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
  it("a 4-leaf root equals the contract's bottom-up keccak fold over [count, ...leaves]", () => {
    const l = [0, 1, 2, 3].map((n) =>
      Buffer.from(
        String(n + 1)
          .padStart(2, "0")
          .repeat(32),
        "hex",
      ),
    );
    // Index 0 is the synthetic count leaf, so five nodes fold as
    // ((c,l0),(l1,l2)) x ((l3,l3),(l3,l3)) — the odd trailing node duplicates.
    const nodes = [countLeaf(4), ...l].map(refLeaf);
    let layer = nodes;
    while (layer.length > 1) {
      const next: Buffer[] = [];
      for (let i = 0; i < layer.length; i += 2) {
        next.push(refNode(layer[i]!, i + 1 < layer.length ? layer[i + 1]! : layer[i]!));
      }
      layer = next;
    }
    expect(Buffer.compare(buildTree(l).root, layer[0]!)).toBe(0);
  });
});

// These are the cross-language pin against contracts/test/BrainAuditAnchor.t.sol.
// The SAME hex strings appear there. If either implementation drifts — the
// sha256-vs-keccak bug, or the count leaf being dropped on one side — exactly one
// of the two suites goes red, which is the point.
describe("cross-checked vectors shared with BrainAuditAnchor.t.sol", () => {
  const L = (n: number) => Buffer.from(String(n).padStart(2, "0").repeat(32), "hex");
  const hex = (b: Buffer) => `0x${b.toString("hex")}`;

  it("countLeaf matches the on-chain BrainAuditAnchor.countLeaf vectors", () => {
    expect(hex(countLeaf(3))).toBe(
      "0x9bf4b76acb5ce3bc1fcfdbc898180cc4e30dc22357dc60045998591084e76d59",
    );
    expect(hex(countLeaf(4))).toBe(
      "0xaa0ed86d9ad2fd8bad3f28dbab649a90fbf023704784aed9c3d20335a174f2d7",
    );
  });

  it("roots and proofs match the pinned on-chain vectors", () => {
    const t4 = buildTree([L(1), L(2), L(3), L(4)]);
    expect(hex(t4.root)).toBe("0x7598f950100f29a6dd250e4a6f48d13305f85eebfca5135c4046b20b7ff38dab");
    expect(makeProof(t4, 1).map(hex)).toEqual([
      "0x4f02043ddc57fe1c114cbe5e5c72ff6ec6254c9fcef42ea9cd55a05dd82d27aa",
      "0x8349b973cfde3f5a7800ad0e0d7cdef9658811e31220276feefdd97fd5ad1d93",
      "0xc9fb54b93905eec828f614ad1ea66bd2b9691c16ebc0197d27d4837af754342b",
    ]);
    expect(makeCountProof(t4).map(hex)).toEqual([
      "0xb11a95f7ddcfbdc542f175f12554edd00d11d2bdc67124e3e3f39f1a1e54bc4a",
      "0xa5bc7280b6113eca92b40283cc52f5967e550f8413a3bd42c0b2d4e26532b326",
      "0xc9fb54b93905eec828f614ad1ea66bd2b9691c16ebc0197d27d4837af754342b",
    ]);

    const t3 = buildTree([L(1), L(2), L(3)]);
    expect(hex(t3.root)).toBe("0x2fa7ac6b90efb497cf9d8cbe2aca1c10c4cef781ca3a8d6738c8fe66d1833a17");
    expect(makeProof(t3, 1).map(hex)).toEqual([
      "0x4f02043ddc57fe1c114cbe5e5c72ff6ec6254c9fcef42ea9cd55a05dd82d27aa",
      "0x0d5bf192b6daf2b29c4d7a69bd3945e9a93a887ef90f8b7c55f9c3dbc2160756",
    ]);
    expect(makeCountProof(t3).map(hex)).toEqual([
      "0xb11a95f7ddcfbdc542f175f12554edd00d11d2bdc67124e3e3f39f1a1e54bc4a",
      "0xa5bc7280b6113eca92b40283cc52f5967e550f8413a3bd42c0b2d4e26532b326",
    ]);
  });
});

describe("the root proves completeness, not only membership", () => {
  const L = (n: number) => Buffer.from(String(n).padStart(2, "0").repeat(32), "hex");

  it("[A,B,C] and [A,B,C,C] no longer collide", () => {
    // The tree still duplicates a trailing odd node, so the FOLD is the same.
    // The count leaf is what separates the roots, which is exactly what stops an
    // anchor claiming eventCount = 4 over a 3-event window.
    const three = buildTree([L(1), L(2), L(3)]);
    const forged = buildTree([L(1), L(2), L(3), L(3)]);
    expect(Buffer.compare(three.root, forged.root)).not.toBe(0);
  });

  it("the count leaf is provable against the root", () => {
    const t = buildTree([L(1), L(2), L(3)]);
    expect(verifyProof(t.root, countLeaf(3), makeCountProof(t))).toBe(true);
    expect(verifyProof(t.root, countLeaf(4), makeCountProof(t))).toBe(false);
  });

  it("every leaf count yields a distinct root for the same leaves", () => {
    const roots = new Set<string>();
    for (let n = 1; n <= 8; n += 1) {
      const leaves = Array.from({ length: n }, (_, i) => L(i + 1));
      roots.add(buildTree(leaves).root.toString("hex"));
    }
    expect(roots.size).toBe(8);
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
  it("pairs the leaf with the count leaf; its proof is the count-leaf hash", () => {
    const leaf = Buffer.from("aa".repeat(32), "hex");
    const t = buildTree([leaf]);
    // Not the bare leaf hash any more: index 0 is the count leaf.
    expect(Buffer.compare(t.root, hashLeafKeccak(leaf))).not.toBe(0);
    expect(Buffer.compare(t.root, leaf)).not.toBe(0);
    expect(
      Buffer.compare(
        t.root,
        hashInternalKeccak(hashLeafKeccak(countLeaf(1)), hashLeafKeccak(leaf)),
      ),
    ).toBe(0);
    expect(verifyProof(t.root, leaf, makeProof(t, 0))).toBe(true);
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
