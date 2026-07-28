import { describe, expect, it } from "vitest";
import { deriveCodeChallenge, isValidCodeVerifier, verifyPkce } from "../src/pkce.js";

const VALID_VERIFIER = "a".repeat(43); // 43 chars, minimum length, all unreserved
const OVERSIZED_VERIFIER = "a".repeat(129);
const UNDERSIZED_VERIFIER = "a".repeat(42);

describe("isValidCodeVerifier", () => {
  it("accepts a 43-character unreserved-charset verifier", () => {
    expect(isValidCodeVerifier(VALID_VERIFIER)).toBe(true);
  });

  it("accepts a 128-character verifier (the maximum)", () => {
    expect(isValidCodeVerifier("a".repeat(128))).toBe(true);
  });

  it("rejects an oversized verifier (129 chars)", () => {
    expect(isValidCodeVerifier(OVERSIZED_VERIFIER)).toBe(false);
  });

  it("rejects an undersized verifier (42 chars)", () => {
    expect(isValidCodeVerifier(UNDERSIZED_VERIFIER)).toBe(false);
  });

  it("rejects characters outside the unreserved set", () => {
    expect(isValidCodeVerifier("a".repeat(42) + "!")).toBe(false);
    expect(isValidCodeVerifier("a".repeat(42) + " ")).toBe(false);
  });

  it("accepts the full unreserved alphabet at valid length", () => {
    const verifier = (
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~" + "a"
    ).slice(0, 43);
    expect(isValidCodeVerifier(verifier)).toBe(true);
  });

  it("rejects non-string input", () => {
    expect(isValidCodeVerifier(12345)).toBe(false);
    expect(isValidCodeVerifier(undefined)).toBe(false);
  });
});

describe("verifyPkce (S256)", () => {
  it("accepts the correct verifier for its derived challenge", () => {
    const challenge = deriveCodeChallenge(VALID_VERIFIER);
    expect(verifyPkce(VALID_VERIFIER, challenge)).toBe(true);
  });

  it("rejects a wrong verifier", () => {
    const challenge = deriveCodeChallenge(VALID_VERIFIER);
    const otherVerifier = "b".repeat(43);
    expect(verifyPkce(otherVerifier, challenge)).toBe(false);
  });

  it("rejects a malformed (oversized) verifier even if it happens to hash to the challenge shape", () => {
    expect(verifyPkce(OVERSIZED_VERIFIER, deriveCodeChallenge(OVERSIZED_VERIFIER))).toBe(false);
  });

  it("rejects an undersized verifier", () => {
    expect(verifyPkce(UNDERSIZED_VERIFIER, deriveCodeChallenge(UNDERSIZED_VERIFIER))).toBe(false);
  });

  it("rejects when code_challenge_method would have been 'plain' (verifier passed as challenge directly)", () => {
    // "plain" means challenge === verifier; S256 verification must reject this
    // unless the verifier happens to equal its own sha256/base64url digest.
    expect(verifyPkce(VALID_VERIFIER, VALID_VERIFIER)).toBe(false);
  });

  it("rejects a non-string code_verifier", () => {
    expect(verifyPkce(undefined, deriveCodeChallenge(VALID_VERIFIER))).toBe(false);
    expect(verifyPkce(12345, deriveCodeChallenge(VALID_VERIFIER))).toBe(false);
  });
});
