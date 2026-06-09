import { describe, expect, it } from "vitest";
import { parseDateParam, parsePositiveIntParam } from "./query-params.js";

describe("parsePositiveIntParam", () => {
  const opts = { fallback: 100, max: 500 };

  it("returns the fallback when absent and the value when valid", () => {
    expect(parsePositiveIntParam("limit", undefined, opts)).toBe(100);
    expect(parsePositiveIntParam("limit", "50", opts)).toBe(50);
    expect(parsePositiveIntParam("limit", " 50 ", opts)).toBe(50); // trims
    expect(parsePositiveIntParam("limit", "1", opts)).toBe(1);
  });

  it("clamps to max instead of rejecting (preserves cap behavior)", () => {
    expect(parsePositiveIntParam("limit", "9999", opts)).toBe(500);
  });

  it("rejects garbage, negatives, zero, fractions, and exponent forms with 400", () => {
    for (const bad of ["abc", "-5", "0", "3.5", "1e9", ""]) {
      expect(() => parsePositiveIntParam("limit", bad, opts)).toThrow(
        expect.objectContaining({ code: "request_params_invalid" }),
      );
    }
  });
});

describe("parseDateParam", () => {
  it("returns undefined when absent and a Date when valid", () => {
    expect(parseDateParam("since", undefined)).toBeUndefined();
    expect(parseDateParam("since", "2026-06-08T00:00:00.000Z")?.toISOString()).toBe(
      "2026-06-08T00:00:00.000Z",
    );
  });

  it("rejects non-dates with 400 request_params_invalid", () => {
    expect(() => parseDateParam("since", "garbage")).toThrow(
      expect.objectContaining({ code: "request_params_invalid" }),
    );
  });
});
