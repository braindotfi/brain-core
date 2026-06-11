import { describe, expect, it } from "vitest";
import { extractorForParser, registeredParsers } from "./registry.js";

describe("finch_v1 parser registration", () => {
  it("registers in the parser registry (the worker polls it automatically)", () => {
    expect(registeredParsers()).toContain("finch_v1");
    expect(extractorForParser("finch_v1")).toBeDefined();
  });
});
