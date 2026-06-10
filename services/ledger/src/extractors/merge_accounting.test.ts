import { describe, expect, it } from "vitest";
import { extractorForParser, registeredParsers } from "./registry.js";

describe("merge_accounting_v1 parser registration", () => {
  it("registers in the parser registry (the worker polls it automatically)", () => {
    expect(registeredParsers()).toContain("merge_accounting_v1");
    expect(extractorForParser("merge_accounting_v1")).toBeDefined();
  });
});
