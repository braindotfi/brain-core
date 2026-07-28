import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { newRawToken, sha256Hex } from "../src/token.js";

describe("token helpers", () => {
  it("newRawToken is 32 random bytes, base64url encoded", () => {
    const a = newRawToken();
    const b = newRawToken();
    expect(a).not.toBe(b);
    // base64url of 32 bytes has no padding and is 43 chars.
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("sha256Hex round-trips against node:crypto directly", () => {
    const raw = "abc123";
    expect(sha256Hex(raw)).toBe(createHash("sha256").update(raw).digest("hex"));
  });

  it("sha256Hex is deterministic and never returns the raw input", () => {
    const raw = newRawToken();
    const hash1 = sha256Hex(raw);
    const hash2 = sha256Hex(raw);
    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe(raw);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
  });
});
