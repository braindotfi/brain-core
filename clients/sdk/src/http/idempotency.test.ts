import { describe, expect, it } from "vitest";
import {
  generateIdempotencyKey,
  looksLikeIdempotencyKey,
} from "./idempotency.js";

describe("generateIdempotencyKey", () => {
  it("returns a non-empty string with the idem_ prefix", () => {
    const k = generateIdempotencyKey();
    expect(k).toMatch(/^idem_[0-9a-f]{32}$/);
  });

  it("returns distinct keys on each call (collision resistance)", () => {
    const keys = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      keys.add(generateIdempotencyKey());
    }
    expect(keys.size).toBe(1000);
  });

  it("uses lowercase hex with no hyphens", () => {
    const k = generateIdempotencyKey();
    expect(k.slice(5)).not.toMatch(/-/);
    expect(k.slice(5)).toMatch(/^[0-9a-f]+$/);
  });
});

describe("looksLikeIdempotencyKey", () => {
  it("accepts SDK-generated keys", () => {
    expect(looksLikeIdempotencyKey(generateIdempotencyKey())).toBe(true);
  });
  it("accepts custom-but-prefixed keys", () => {
    expect(looksLikeIdempotencyKey("idem_custom_key_1")).toBe(true);
  });
  it("rejects keys missing the prefix", () => {
    expect(looksLikeIdempotencyKey("custom_key_1")).toBe(false);
  });
  it("rejects the prefix alone", () => {
    expect(looksLikeIdempotencyKey("idem_")).toBe(false);
  });
});
