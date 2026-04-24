import { describe, expect, it } from "vitest";
import { vectorLiteral } from "./entities.js";

describe("vectorLiteral", () => {
  it("formats as [a,b,c] with no spaces", () => {
    expect(vectorLiteral([1, 2, 3])).toBe("[1,2,3]");
    expect(vectorLiteral([0.5, -0.25, 0])).toBe("[0.5,-0.25,0]");
  });
  it("replaces non-finite values with 0 (no NaN / Infinity leak into SQL)", () => {
    expect(vectorLiteral([1, Number.NaN, Number.POSITIVE_INFINITY, -1])).toBe("[1,0,0,-1]");
  });
});
