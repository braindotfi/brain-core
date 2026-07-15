import { describe, expect, it } from "vitest";
import { assertMoneyPathLoadersWiredInProduction } from "./payment-loaders-prod-fence.js";

const allWired = {
  hasResolveTenantFlags: true,
  hasResolveEvidence: true,
  hasDetectDuplicates: true,
  hasSumActiveReservations: true,
  hasAttestCounterpartyAgent: true,
  hasSumAgentWindowSpend: true,
  hasResolveObligationConfidence: true,
  hasResolveObligationDirection: true,
};

describe("assertMoneyPathLoadersWiredInProduction", () => {
  it("is silent in development even with loaders missing", () => {
    expect(() =>
      assertMoneyPathLoadersWiredInProduction({
        nodeEnv: "development",
        hasResolveTenantFlags: false,
        hasResolveEvidence: false,
        hasDetectDuplicates: false,
        hasSumActiveReservations: false,
        hasAttestCounterpartyAgent: false,
        hasSumAgentWindowSpend: false,
        hasResolveObligationConfidence: false,
        hasResolveObligationDirection: false,
      }),
    ).not.toThrow();
  });

  it("is silent in test", () => {
    expect(() =>
      assertMoneyPathLoadersWiredInProduction({
        nodeEnv: "test",
        hasResolveTenantFlags: false,
        hasResolveEvidence: false,
        hasDetectDuplicates: false,
        hasSumActiveReservations: false,
        hasAttestCounterpartyAgent: false,
        hasSumAgentWindowSpend: false,
        hasResolveObligationConfidence: false,
        hasResolveObligationDirection: false,
      }),
    ).not.toThrow();
  });

  it("is silent when nodeEnv is unset (treated as non-production)", () => {
    expect(() =>
      assertMoneyPathLoadersWiredInProduction({
        nodeEnv: undefined,
        hasResolveTenantFlags: false,
        hasResolveEvidence: false,
        hasDetectDuplicates: false,
        hasSumActiveReservations: false,
        hasAttestCounterpartyAgent: false,
        hasSumAgentWindowSpend: false,
        hasResolveObligationConfidence: false,
        hasResolveObligationDirection: false,
      }),
    ).not.toThrow();
  });

  it("is silent in production when every always-applicable loader is wired", () => {
    expect(() =>
      assertMoneyPathLoadersWiredInProduction({ nodeEnv: "production", ...allWired }),
    ).not.toThrow();
  });

  it("throws in production when resolveObligationConfidence is missing (C-4)", () => {
    expect(() =>
      assertMoneyPathLoadersWiredInProduction({
        nodeEnv: "production",
        ...allWired,
        hasResolveObligationConfidence: false,
      }),
    ).toThrow(/resolveObligationConfidence/);
  });

  it("throws in production when resolveTenantFlags is missing (check 1.5)", () => {
    expect(() =>
      assertMoneyPathLoadersWiredInProduction({
        nodeEnv: "production",
        ...allWired,
        hasResolveTenantFlags: false,
      }),
    ).toThrow(/resolveTenantFlags/);
  });

  it("throws in production when resolveEvidence is missing", () => {
    expect(() =>
      assertMoneyPathLoadersWiredInProduction({
        nodeEnv: "production",
        ...allWired,
        hasResolveEvidence: false,
      }),
    ).toThrow(/resolveEvidence/);
  });

  it("throws in production when detectDuplicates is missing", () => {
    expect(() =>
      assertMoneyPathLoadersWiredInProduction({
        nodeEnv: "production",
        ...allWired,
        hasDetectDuplicates: false,
      }),
    ).toThrow(/detectDuplicates/);
  });

  it("throws in production when sumActiveReservations is missing (M-1)", () => {
    // Batch 11 M-1 regression: §6 check 8 falls back to `reserved="0"` when
    // the reservations loader is absent (gate.ts ~L685), silently opening
    // the parallel double-spend window the check exists to close. The
    // factory currently keeps the loader required (compiler-enforced), but
    // a future refactor that re-introduces optionality would have no boot
    // signal without this fence row. Codex/Opus P0-1.
    expect(() =>
      assertMoneyPathLoadersWiredInProduction({
        nodeEnv: "production",
        ...allWired,
        hasSumActiveReservations: false,
      }),
    ).toThrow(/sumActiveReservations/);
  });

  it("throws in production when attestCounterpartyAgent is missing (check 5.5)", () => {
    expect(() =>
      assertMoneyPathLoadersWiredInProduction({
        nodeEnv: "production",
        ...allWired,
        hasAttestCounterpartyAgent: false,
      }),
    ).toThrow(/attestCounterpartyAgent/);
  });

  it("throws in production when sumAgentWindowSpend is missing (check 8.5)", () => {
    expect(() =>
      assertMoneyPathLoadersWiredInProduction({
        nodeEnv: "production",
        ...allWired,
        hasSumAgentWindowSpend: false,
      }),
    ).toThrow(/sumAgentWindowSpend/);
  });

  it("throws in production when resolveObligationDirection is missing (H-1)", () => {
    // Batch 10 H-1 regression: the §6 gate's outflow-receivable rejection
    // is silently dormant when this loader is absent. Production booting
    // without it would let an "AR drain" intent (outflow targeting a
    // receivable) skate through the gate as `not_applicable`.
    expect(() =>
      assertMoneyPathLoadersWiredInProduction({
        nodeEnv: "production",
        ...allWired,
        hasResolveObligationDirection: false,
      }),
    ).toThrow(/resolveObligationDirection/);
  });

  it("lists every missing loader in the error", () => {
    expect(() =>
      assertMoneyPathLoadersWiredInProduction({
        nodeEnv: "production",
        hasResolveTenantFlags: false,
        hasResolveEvidence: false,
        hasDetectDuplicates: false,
        hasSumActiveReservations: false,
        hasAttestCounterpartyAgent: false,
        hasSumAgentWindowSpend: false,
        hasResolveObligationConfidence: false,
        hasResolveObligationDirection: false,
      }),
    ).toThrow(
      /resolveTenantFlags.*resolveEvidence.*detectDuplicates.*sumActiveReservations.*attestCounterpartyAgent.*sumAgentWindowSpend.*resolveObligationConfidence.*resolveObligationDirection/s,
    );
  });
});
