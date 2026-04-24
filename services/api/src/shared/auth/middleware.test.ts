import { describe, expect, it } from "vitest";
import { extractBearer } from "./middleware.js";

describe("extractBearer", () => {
  it("extracts the token when header is well-formed", () => {
    expect(extractBearer("Bearer abc.def.ghi")).toBe("abc.def.ghi");
  });

  it("is case-insensitive on the scheme", () => {
    expect(extractBearer("bearer token")).toBe("token");
    expect(extractBearer("BEARER token")).toBe("token");
  });

  it("trims whitespace around the header", () => {
    expect(extractBearer("  Bearer abc  ")).toBe("abc");
  });

  it("returns null for unknown schemes", () => {
    expect(extractBearer("Basic abc")).toBe(null);
  });

  it("returns null for missing header", () => {
    expect(extractBearer(undefined)).toBe(null);
  });

  it("returns null for empty header", () => {
    expect(extractBearer("")).toBe(null);
    expect(extractBearer("Bearer")).toBe(null);
  });
});
