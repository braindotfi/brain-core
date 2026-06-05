import { describe, expect, it } from "vitest";
import { assertMoneyPathLoadersWiredInProduction } from "./payment-loaders-prod-fence.js";

const allWired = {
  hasResolveEvidence: true,
  hasDetectDuplicates: true,
  hasResolveObligationConfidence: true,
};

describe("assertMoneyPathLoadersWiredInProduction", () => {
  it("is silent in development even with loaders missing", () => {
    expect(() =>
      assertMoneyPathLoadersWiredInProduction({
        nodeEnv: "development",
        hasResolveEvidence: false,
        hasDetectDuplicates: false,
        hasResolveObligationConfidence: false,
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

  it("lists every missing loader in the error", () => {
    expect(() =>
      assertMoneyPathLoadersWiredInProduction({
        nodeEnv: "production",
        hasResolveEvidence: false,
        hasDetectDuplicates: false,
        hasResolveObligationConfidence: false,
      }),
    ).toThrow(/resolveEvidence.*detectDuplicates.*resolveObligationConfidence/s);
  });
});
