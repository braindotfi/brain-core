import { describe, expect, it } from "vitest";
import { SingleIntentDecomposer } from "./intent-decomposer.js";

describe("SingleIntentDecomposer", () => {
  it("returns the intent unchanged as a single-element list", async () => {
    const d = new SingleIntentDecomposer();
    expect(await d.decompose("pay the invoice and sweep idle cash")).toEqual([
      "pay the invoice and sweep idle cash",
    ]);
  });
});
