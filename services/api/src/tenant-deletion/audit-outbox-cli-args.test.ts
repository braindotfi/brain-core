import { describe, expect, it } from "vitest";
import { parseBoundedInt, resolveSourceCommit } from "./audit-outbox-cli-args.js";

describe("parseBoundedInt", () => {
  const bounds = { min: 1, max: 1000 };

  it("accepts a plain in-range integer", () => {
    expect(parseBoundedInt("limit", "50", bounds)).toBe(50);
    expect(parseBoundedInt("limit", "  50  ", bounds)).toBe(50); // trims
    expect(parseBoundedInt("limit", "1", bounds)).toBe(1); // min boundary
    expect(parseBoundedInt("limit", "1000", bounds)).toBe(1000); // max boundary
  });

  it("rejects non-numeric input", () => {
    expect(() => parseBoundedInt("limit", "abc", bounds)).toThrow(/whole number/);
    expect(() => parseBoundedInt("limit", "", bounds)).toThrow(/whole number/);
  });

  it("rejects non-integer and exponent/hex forms that Number() would coerce", () => {
    expect(() => parseBoundedInt("limit", "3.5", bounds)).toThrow(/whole number/);
    expect(() => parseBoundedInt("limit", "1e9", bounds)).toThrow(/whole number/);
    expect(() => parseBoundedInt("limit", "0x10", bounds)).toThrow(/whole number/);
  });

  it("rejects out-of-range values (negative, zero below min, over max)", () => {
    expect(() => parseBoundedInt("limit", "-5", bounds)).toThrow(/between 1 and 1000/);
    expect(() => parseBoundedInt("limit", "0", bounds)).toThrow(/between 1 and 1000/);
    expect(() => parseBoundedInt("limit", "1001", bounds)).toThrow(/between 1 and 1000/);
  });

  it("rejects values beyond the safe-integer range", () => {
    expect(() =>
      parseBoundedInt("older-than", "99999999999999999999", {
        min: 0,
        max: Number.MAX_SAFE_INTEGER,
      }),
    ).toThrow(/out of integer range/);
  });

  it("allows a zero minimum for older-than", () => {
    expect(parseBoundedInt("older-than", "0", { min: 0, max: 100 })).toBe(0);
  });
});

describe("resolveSourceCommit", () => {
  it("returns the first non-empty source-commit env var in precedence order", () => {
    expect(resolveSourceCommit({ BRAIN_BUILD_SHA: "abc123", GIT_COMMIT: "def456" })).toBe("abc123");
    expect(resolveSourceCommit({ GIT_COMMIT: "def456" })).toBe("def456");
    expect(resolveSourceCommit({ SOURCE_COMMIT: "zzz" })).toBe("zzz");
  });

  it("skips empty strings", () => {
    expect(resolveSourceCommit({ BRAIN_BUILD_SHA: "", GIT_SHA: "real" })).toBe("real");
  });

  it("returns undefined when no source-commit var is set", () => {
    expect(resolveSourceCommit({})).toBeUndefined();
    expect(resolveSourceCommit({ UNRELATED: "x" })).toBeUndefined();
  });
});
