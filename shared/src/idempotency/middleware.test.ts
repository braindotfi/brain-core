import { describe, expect, it } from "vitest";
import { _internal } from "./middleware.js";

const { serializeBody, coerceToString } = _internal;

describe("serializeBody", () => {
  it("returns empty string for null/undefined", () => {
    expect(serializeBody(null)).toBe("");
    expect(serializeBody(undefined)).toBe("");
  });
  it("returns strings as-is", () => {
    expect(serializeBody("hello")).toBe("hello");
  });
  it("decodes Buffer as utf8", () => {
    expect(serializeBody(Buffer.from("hi"))).toBe("hi");
  });
  it("JSON-stringifies objects", () => {
    expect(serializeBody({ a: 1 })).toBe(`{"a":1}`);
  });
});

describe("coerceToString", () => {
  it("mirrors serializeBody for payload handling", () => {
    expect(coerceToString(null)).toBe("");
    expect(coerceToString("abc")).toBe("abc");
    expect(coerceToString(Buffer.from("abc"))).toBe("abc");
    expect(coerceToString({ a: 1 })).toBe(`{"a":1}`);
  });
});
