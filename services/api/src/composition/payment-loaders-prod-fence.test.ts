import { describe, expect, it } from "vitest";
import { assertMoneyPathLoadersWiredInProduction } from "./payment-loaders-prod-fence.js";

const allWired = {
  hasResolveEvidence: true,
  hasDetectDuplicates: true,
  hasResolveObligationConfidence: true,
  hasResolveObligationDirection: true,
};

describe("assertMoneyPathLoadersWiredInProduction", () => {
  it("is silent in development even with loaders missing", () => {
    expect(() =>
      assertMoneyPathLoadersWiredInProduction({
        nodeEnv: "development",
        hasResolveEvidence: false,
        hasDetectDuplicates: false,
        hasResolveObligationConfidence: false,
        hasResolveObligationDirection: false,
      }),
    ).not.toThrow();
  });

  it("is silent in test", () => {
    expect(() =>
      assertMoneyPathLoadersWiredInProduction({
        nodeEnv: "test",
        hasResolveEvidence: false,
        hasDetectDuplicates: false,
        hasResolveObligationConfidence: false,
        hasResolveObligationDirection: false,
      }),
    ).not.toThrow();
  });

  it("is silent when nodeEnv is unset (treated as non-production)", () => {
    expect(() =>
      assertMoneyPathLoadersWiredInProduction({
        nodeEnv: undefined,
        hasResolveEvidence: false,
        hasDetectDuplicates: false,
        hasResolveObligationConfidence: false,
        hasResolveObligationDirection: false,
      }),
    ).not.toThrow();
  });

  it("is silent in production when all three loaders are wired", () => {
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
        hasResolveEvidence: false,
        hasDetectDuplicates: false,
        hasResolveObligationConfidence: false,
        hasResolveObligationDirection: false,
      }),
    ).toThrow(
      /resolveEvidence.*detectDuplicates.*resolveObligationConfidence.*resolveObligationDirection/s,
    );
  });
});
