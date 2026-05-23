import { describe, expect, it } from "vitest";
import { computeLedgerSnapshot, type LedgerStateInput } from "./snapshot.js";

function state(overrides: Partial<LedgerStateInput> = {}): LedgerStateInput {
  return {
    account: { id: "acct_1", status: "active", currency: "USD", available_balance: "1000.00" },
    counterparty: {
      id: "cp_1",
      type: "vendor",
      risk_level: "low",
      verified_status: "document_verified",
    },
    ...overrides,
  };
}

describe("computeLedgerSnapshot", () => {
  it("is deterministic for the same state", () => {
    expect(computeLedgerSnapshot(state())).toBe(computeLedgerSnapshot(state()));
  });

  it("is independent of object key insertion order", () => {
    const a = computeLedgerSnapshot({
      account: { available_balance: "1000.00", currency: "USD", id: "acct_1", status: "active" },
      counterparty: {
        verified_status: "document_verified",
        risk_level: "low",
        type: "vendor",
        id: "cp_1",
      },
    });
    expect(a).toBe(computeLedgerSnapshot(state()));
  });

  it("normalizes decimal balances (100.00 == 100)", () => {
    const a = computeLedgerSnapshot(
      state({ account: { ...state().account, available_balance: "100.00" } }),
    );
    const b = computeLedgerSnapshot(
      state({ account: { ...state().account, available_balance: "100" } }),
    );
    expect(a).toBe(b);
  });

  it("changes when any security-relevant field changes", () => {
    const base = computeLedgerSnapshot(state());
    expect(
      computeLedgerSnapshot(
        state({ account: { ...state().account, available_balance: "999.99" } }),
      ),
    ).not.toBe(base);
    expect(
      computeLedgerSnapshot(
        state({ counterparty: { ...state().counterparty, risk_level: "high" } }),
      ),
    ).not.toBe(base);
    expect(
      computeLedgerSnapshot(
        state({ counterparty: { ...state().counterparty, verified_status: "unverified" } }),
      ),
    ).not.toBe(base);
  });

  it("handles a null balance distinctly from a zero balance", () => {
    const nul = computeLedgerSnapshot(
      state({ account: { ...state().account, available_balance: null } }),
    );
    const zero = computeLedgerSnapshot(
      state({ account: { ...state().account, available_balance: "0" } }),
    );
    expect(nul).not.toBe(zero);
  });
});
