import { describe, expect, it } from "vitest";
import { RulesIntentClassifier } from "./intent-classifier.js";

describe("RulesIntentClassifier", () => {
  const c = new RulesIntentClassifier();

  it("scores 1 when the intent contains every token of a pattern", () => {
    expect(
      c.classify("please follow up on the overdue invoice", ["follow up overdue invoice"]),
    ).toBe(1);
  });

  it("scores partial overlap", () => {
    // 2 of 4 pattern tokens present.
    expect(c.classify("chase the payment", ["chase late payment now"])).toBeCloseTo(0.5);
  });

  it("scores 0 with no overlap", () => {
    expect(c.classify("sweep idle cash", ["follow up overdue invoice"])).toBe(0);
  });

  it("returns the best score across patterns", () => {
    expect(
      c.classify("move excess balance to yield", [
        "follow up invoice",
        "move excess balance yield",
      ]),
    ).toBe(1);
  });

  it("scores 0 for an empty intent", () => {
    expect(c.classify("", ["anything"])).toBe(0);
  });
});
