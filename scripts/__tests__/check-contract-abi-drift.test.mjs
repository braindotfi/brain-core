import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const SCRIPT = join(process.cwd(), "scripts/check-contract-abi-drift.mjs");

/**
 * Build a fixture tree at a fresh tmp dir matching the shape the guard scans:
 *   - contracts/out/<Contract>.sol/<Contract>.json  (a forge JSON artifact)
 *   - <some-ts-file>                                (a TS parseAbi caller)
 * Run the script with that dir as cwd, return { code, stdout, stderr }.
 */
function runGuard({ tsSrc, contractName = "BrainEscrow", abi, methodIdentifiers }) {
  const root = mkdtempSync(join(tmpdir(), "abi-drift-"));
  try {
    if (abi !== "MISSING") {
      const dir = join(root, "contracts/out", `${contractName}.sol`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `${contractName}.json`),
        JSON.stringify({ abi, ...(methodIdentifiers !== undefined ? { methodIdentifiers } : {}) }),
      );
    } else {
      // Force the "contracts/out exists but artifact missing" branch.
      mkdirSync(join(root, "contracts/out"), { recursive: true });
    }
    mkdirSync(join(root, "services/policy/src"), { recursive: true });
    writeFileSync(join(root, "services/policy/src/example.ts"), tsSrc);
    try {
      const stdout = execFileSync("node", [SCRIPT], { cwd: root, encoding: "utf8" });
      return { code: 0, stdout, stderr: "" };
    } catch (err) {
      return {
        code: err.status ?? 1,
        stdout: err.stdout?.toString() ?? "",
        stderr: err.stderr?.toString() ?? "",
      };
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** A correct fixture: the TS signature matches the on-disk ABI exactly. */
const ALIGNED_ABI = [
  {
    type: "function",
    name: "getEscrow",
    inputs: [{ name: "escrowId", type: "bytes32", internalType: "bytes32" }],
    outputs: [],
    stateMutability: "view",
  },
];
const ALIGNED_TS = `
import { parseAbi } from "viem";
const ESCROW_ABI = parseAbi([
  "function getEscrow(bytes32 escrowId) external view returns (address payer)",
]);
export { ESCROW_ABI };
`;

test("aligned ABI: guard passes silently with exit 0", () => {
  const r = runGuard({ tsSrc: ALIGNED_TS, abi: ALIGNED_ABI });
  assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stdout, /OK -- 1 parseAbi block/);
});

test("drifted signature name (function was renamed on chain) is flagged", () => {
  // The on-disk ABI has the function under a NEW name; the TS still calls the
  // old one. That is the exact "selector drift" the guard exists to catch.
  const DRIFTED = [
    {
      type: "function",
      name: "getEscrowDetails", // was getEscrow before the rename
      inputs: [{ name: "escrowId", type: "bytes32", internalType: "bytes32" }],
      outputs: [],
      stateMutability: "view",
    },
  ];
  const r = runGuard({ tsSrc: ALIGNED_TS, abi: DRIFTED });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /ABI DRIFT/);
  assert.match(r.stderr, /getEscrow/);
});

test("drifted parameter type is flagged", () => {
  // The on-disk ABI now takes bytes32 + uint8 (a new arg appeared); the TS
  // still passes a single bytes32. This is the kind of upgrade that compiles
  // but silently reverts at the encoder.
  const DRIFTED = [
    {
      type: "function",
      name: "getEscrow",
      inputs: [
        { name: "escrowId", type: "bytes32", internalType: "bytes32" },
        { name: "version", type: "uint8", internalType: "uint8" },
      ],
      outputs: [],
      stateMutability: "view",
    },
  ];
  const r = runGuard({ tsSrc: ALIGNED_TS, abi: DRIFTED });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /ABI DRIFT/);
});

test("unknown variable name is silently ignored (not in KNOWN_VARS)", () => {
  // A third-party ABI we don't govern (e.g. USDC) does not get flagged when
  // there's no matching artifact: it isn't in KNOWN_VARS, so the guard
  // never tries to look it up.
  const r = runGuard({
    tsSrc: `
import { parseAbi } from "viem";
const USDC_ABI = parseAbi([
  "function transfer(address recipient, uint256 amount) external returns (bool)",
]);
export { USDC_ABI };
`,
    abi: ALIGNED_ABI, // present, but for BrainEscrow -- USDC_ABI doesn't resolve here
  });
  assert.equal(r.code, 0);
  // No blocks matched, so the guard prints its "no parseAbi blocks matched
  // KNOWN_VARS" notice and exits 0.
  assert.match(r.stdout, /no parseAbi blocks matched KNOWN_VARS/);
});

test("missing forge artifact for a known variable is flagged", () => {
  // contracts/out exists but the specific contract JSON is absent. The
  // guard reports ABI MISSING and exits 1 -- you cannot ship code that
  // calls a contract whose ABI we have not committed.
  const r = runGuard({ tsSrc: ALIGNED_TS, abi: "MISSING" });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /ABI MISSING/);
});

// --- PINNED_SELECTORS literal-vs-methodIdentifiers checks (T4) -----------
//
// A signature that still resolves to a real function on the contract proves
// the NAME wasn't retired -- it says nothing about whether the registered
// hex LITERAL actually encodes that signature. This is the exact shape the
// original C1 bug shipped in: RELEASE_SELECTOR = "0x84f97fba" registered
// against the correct signature "function release(bytes32,uint256)", but
// BrainEscrow's real selector for that signature is 0x66afd8ef.

const RELEASE_ABI = [
  {
    type: "function",
    name: "release",
    inputs: [
      { name: "escrowId", type: "bytes32", internalType: "bytes32" },
      { name: "amount", type: "uint256", internalType: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
];
const RELEASE_METHOD_IDENTIFIERS = { "release(bytes32,uint256)": "66afd8ef" };
const releaseSelectorTs = (hex) => `
const RELEASE_SELECTOR = "${hex}";
export { RELEASE_SELECTOR };
`;

test("PINNED_SELECTORS: the correct literal passes", () => {
  const r = runGuard({
    tsSrc: releaseSelectorTs("0x66afd8ef"),
    contractName: "BrainEscrow",
    abi: RELEASE_ABI,
    methodIdentifiers: RELEASE_METHOD_IDENTIFIERS,
  });
  assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
});

test("PINNED_SELECTORS: a transposed literal is flagged even though the signature still resolves (C1 negative control)", () => {
  const r = runGuard({
    tsSrc: releaseSelectorTs("0x84f97fba"),
    contractName: "BrainEscrow",
    abi: RELEASE_ABI,
    methodIdentifiers: RELEASE_METHOD_IDENTIFIERS,
  });
  assert.equal(r.code, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stderr, /\[SELECTOR\]/);
  assert.match(r.stderr, /does not encode it/);
  assert.match(r.stderr, /0x66afd8ef/);
});

test("PINNED_SELECTORS: a missing methodIdentifiers entry is flagged, not silently passed", () => {
  const r = runGuard({
    tsSrc: releaseSelectorTs("0x66afd8ef"),
    contractName: "BrainEscrow",
    abi: RELEASE_ABI,
    methodIdentifiers: {}, // artifact predates methodIdentifiers, or the key is absent
  });
  assert.equal(r.code, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stderr, /methodIdentifiers/);
});

test("no contracts/out at all (fresh clone without forge) skips, does not fail", () => {
  // A fresh clone that never ran `forge build`: the guard MUST NOT block
  // every PR. Skip cleanly instead.
  const root = mkdtempSync(join(tmpdir(), "abi-drift-noout-"));
  try {
    mkdirSync(join(root, "services/policy/src"), { recursive: true });
    writeFileSync(join(root, "services/policy/src/example.ts"), ALIGNED_TS);
    try {
      const stdout = execFileSync("node", [SCRIPT], { cwd: root, encoding: "utf8" });
      assert.match(stdout, /skip/);
    } catch (err) {
      assert.fail(`should not throw without contracts/out, got: ${err.stderr}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
