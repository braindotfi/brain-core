import { describe, expect, it } from "vitest";
import { capabilityHash } from "./capability.js";

describe("capabilityHash", () => {
  it("matches the known keccak256 vector for the empty string", () => {
    // keccak256("") — canonical Ethereum empty-input hash.
    expect(capabilityHash("")).toBe(
      "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
    );
  });

  it("returns a 0x-prefixed 32-byte lowercase hex string", () => {
    expect(capabilityHash("collections_followup")).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("is deterministic", () => {
    expect(capabilityHash("treasury_sweep")).toBe(capabilityHash("treasury_sweep"));
  });

  it("distinguishes different capabilities", () => {
    expect(capabilityHash("collections_followup")).not.toBe(capabilityHash("treasury_sweep"));
  });
});
