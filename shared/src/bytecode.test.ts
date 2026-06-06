import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  deployedRuntimeMatches,
  flattenImmutableReferences,
  isValidImmutableRefs,
  maskImmutables,
  maskedRuntimeSha256,
} from "./bytecode.js";

// The real BrainEscrow Foundry artifact (has the `arbiter` immutable at 3 byte
// offsets). The masking logic must be correct against it, not just synthetic data.
const artifact = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../contracts/out/BrainEscrow.sol/BrainEscrow.json", import.meta.url)),
    "utf8",
  ),
) as { deployedBytecode: { object: string; immutableReferences: Record<string, never> } };

const RUNTIME = artifact.deployedBytecode.object;
const STRIPPED = RUNTIME.replace(/^0x/, "");
const REFS = flattenImmutableReferences(artifact.deployedBytecode.immutableReferences);
const EXPECTED = maskedRuntimeSha256(RUNTIME, REFS);

/** Write `value` into a 32-byte immutable slot at byteOffset. */
function setSlot(hexNo0x: string, byteOffset: number, value: number): string {
  const buf = Buffer.from(hexNo0x, "hex");
  buf.fill(value, byteOffset, byteOffset + 32);
  return buf.toString("hex");
}

describe("flattenImmutableReferences", () => {
  it("flattens the BrainEscrow arbiter immutable (3 ranges of 32 bytes)", () => {
    expect(REFS.length).toBe(3);
    expect(REFS.every((r) => r.length === 32)).toBe(true);
    // sorted by start
    expect(REFS.map((r) => r.start)).toEqual([...REFS.map((r) => r.start)].sort((a, b) => a - b));
  });
  it("returns [] for null/undefined", () => {
    expect(flattenImmutableReferences(null)).toEqual([]);
    expect(flattenImmutableReferences(undefined)).toEqual([]);
  });
});

describe("deployedRuntimeMatches (real BrainEscrow artifact)", () => {
  it("matches the exact artifact runtime", () => {
    expect(deployedRuntimeMatches(RUNTIME, EXPECTED, REFS).match).toBe(true);
  });

  it("STILL matches when ONLY the immutable bytes differ (the deployed arbiter address)", () => {
    let deployed = STRIPPED;
    for (const r of REFS) deployed = setSlot(deployed, r.start, 0xab);
    expect(deployed).not.toBe(STRIPPED); // the bytecode genuinely changed
    expect(deployedRuntimeMatches(deployed, EXPECTED, REFS).match).toBe(true);
  });

  it("does NOT match when a byte OUTSIDE the immutables differs", () => {
    const buf = Buffer.from(STRIPPED, "hex");
    buf[0] = buf[0]! ^ 0xff; // offset 0 is not in any immutable range (they start at 301)
    const r = deployedRuntimeMatches(buf.toString("hex"), EXPECTED, REFS);
    expect(r.match).toBe(false);
    expect(r.reason).toMatch(/hash mismatch/);
  });

  it("does NOT match empty code (EOA / no contract at the address)", () => {
    const r = deployedRuntimeMatches("0x", EXPECTED, REFS);
    expect(r.match).toBe(false);
    expect(r.reason).toMatch(/no code/);
  });

  it("does NOT match a too-short / wrong-shape deployment", () => {
    const r = deployedRuntimeMatches("0x6080", EXPECTED, REFS);
    expect(r.match).toBe(false);
    expect(r.reason).toMatch(/out of range/);
  });

  it("ignores 0x casing on input", () => {
    expect(deployedRuntimeMatches(RUNTIME.toUpperCase(), EXPECTED, REFS).match).toBe(true);
  });
});

describe("maskImmutables", () => {
  it("zeroes exactly the immutable byte ranges", () => {
    const masked = Buffer.from(maskImmutables(RUNTIME, REFS), "hex");
    for (const r of REFS) {
      for (let i = r.start; i < r.start + r.length; i += 1) expect(masked[i]).toBe(0);
    }
  });
  it("is a no-op with no refs", () => {
    expect(maskImmutables("deadbeef", [])).toBe("deadbeef");
  });
});

describe("isValidImmutableRefs", () => {
  it("accepts well-formed ranges, rejects malformed", () => {
    expect(isValidImmutableRefs([{ start: 0, length: 32 }])).toBe(true);
    expect(isValidImmutableRefs([])).toBe(true);
    expect(isValidImmutableRefs([{ start: -1, length: 32 }])).toBe(false);
    expect(isValidImmutableRefs([{ start: 0, length: 1.5 }])).toBe(false);
    expect(isValidImmutableRefs("nope")).toBe(false);
    expect(isValidImmutableRefs(null)).toBe(false);
  });
});
