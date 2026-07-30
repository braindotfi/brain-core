import { describe, expect, it } from "vitest";
import { shouldTriggerReconciliation } from "./upload-projection-trigger.js";

const emptySummary = {
  accounts: 0,
  transactions: 0,
  receivables: 0,
  obligations: 0,
  newCounterparties: 0,
};

describe("upload projection agent trigger", () => {
  it("triggers reconciliation for bank-first and receivable-first upload order", () => {
    expect(shouldTriggerReconciliation({ ...emptySummary, transactions: 16 }, true, false)).toBe(
      true,
    );
    expect(
      shouldTriggerReconciliation({ ...emptySummary, receivables: 9, obligations: 9 }, false, true),
    ).toBe(true);
  });

  it("does not trigger reconciliation without both sides of the match", () => {
    expect(shouldTriggerReconciliation({ ...emptySummary, transactions: 16 }, false, false)).toBe(
      false,
    );
    expect(
      shouldTriggerReconciliation(
        { ...emptySummary, receivables: 9, obligations: 9 },
        false,
        false,
      ),
    ).toBe(false);
  });
});
