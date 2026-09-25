import { describe, expect, it } from "vitest";
import {
  assertAtLeastOneLiveRailInProduction,
  assertEscrowRailHasStateLoader,
  assertSmartAccountRegistryForProduction,
} from "./rails-prod-fence.js";

describe("assertAtLeastOneLiveRailInProduction", () => {
  it("is silent in development with zero live rails (dev-stub path)", () => {
    expect(() =>
      assertAtLeastOneLiveRailInProduction({ nodeEnv: "development", liveRailCount: 0 }),
    ).not.toThrow();
  });

  it("is silent in test with zero live rails", () => {
    expect(() =>
      assertAtLeastOneLiveRailInProduction({ nodeEnv: "test", liveRailCount: 0 }),
    ).not.toThrow();
  });

  it("is silent in production when at least one live rail is configured", () => {
    expect(() =>
      assertAtLeastOneLiveRailInProduction({ nodeEnv: "production", liveRailCount: 1 }),
    ).not.toThrow();
    expect(() =>
      assertAtLeastOneLiveRailInProduction({ nodeEnv: "production", liveRailCount: 4 }),
    ).not.toThrow();
  });

  it("throws in production with zero live rails (the dev-stub fallback)", () => {
    expect(() =>
      assertAtLeastOneLiveRailInProduction({ nodeEnv: "production", liveRailCount: 0 }),
    ).toThrow(/No live payment rails configured/);
  });

  it("is silent when nodeEnv is unset (treated as non-production)", () => {
    // Unset NODE_ENV ⇒ behave as dev. A misconfigured deploy without NODE_ENV
    // would surface elsewhere (logs read as 'unset'); this fence is opinionated
    // about prod, not about typos.
    expect(() =>
      assertAtLeastOneLiveRailInProduction({ nodeEnv: undefined, liveRailCount: 0 }),
    ).not.toThrow();
  });
});

describe("assertEscrowRailHasStateLoader", () => {
  it("is silent when escrow rail is not live", () => {
    expect(() =>
      assertEscrowRailHasStateLoader({
        escrowRailLive: false,
        hasResolveEscrowState: false,
        missingEnv: ["BRAIN_X402_USDC_ADDRESS"],
      }),
    ).not.toThrow();
  });

  it("is silent when escrow rail and state loader are both wired", () => {
    expect(() =>
      assertEscrowRailHasStateLoader({
        escrowRailLive: true,
        hasResolveEscrowState: true,
        missingEnv: [],
      }),
    ).not.toThrow();
  });

  it("throws when escrow rail is live without resolveEscrowState", () => {
    expect(() =>
      assertEscrowRailHasStateLoader({
        escrowRailLive: true,
        hasResolveEscrowState: false,
        missingEnv: [],
      }),
    ).toThrow(/resolveEscrowState/);
  });

  it("names the missing env var in the thrown message (T6)", () => {
    // This is what an operator following docs/rails-matrix.md actually reads:
    // "resolveEscrowState is not wired" alone never named BRAIN_X402_USDC_ADDRESS.
    expect(() =>
      assertEscrowRailHasStateLoader({
        escrowRailLive: true,
        hasResolveEscrowState: false,
        missingEnv: ["BRAIN_X402_USDC_ADDRESS"],
      }),
    ).toThrow(/Missing: BRAIN_X402_USDC_ADDRESS/);
  });

  it("still throws (with a generic hint) when hasResolveEscrowState is false but no env is reported missing", () => {
    // Guards the case where the loader failed to construct for a reason other
    // than a missing env var (e.g. a future construction-time throw).
    expect(() =>
      assertEscrowRailHasStateLoader({
        escrowRailLive: true,
        hasResolveEscrowState: false,
        missingEnv: [],
      }),
    ).toThrow(/all of resolveEscrowState's required env appears set/);
  });
});

describe("assertSmartAccountRegistryForProduction", () => {
  it("throws in production when a smart-account rail is configured without registry env", () => {
    expect(() =>
      assertSmartAccountRegistryForProduction({
        nodeEnv: "production",
        smartAccountRailConfigured: true,
        hasTenantAccountRegistry: false,
        missingEnv: ["BRAIN_TENANT_ACCOUNT_REGISTRY_ADDRESS"],
      }),
    ).toThrow(/Missing: BRAIN_TENANT_ACCOUNT_REGISTRY_ADDRESS/);
  });

  it("is silent in production when the registry env is complete", () => {
    expect(() =>
      assertSmartAccountRegistryForProduction({
        nodeEnv: "production",
        smartAccountRailConfigured: true,
        hasTenantAccountRegistry: true,
        missingEnv: [],
      }),
    ).not.toThrow();
  });

  it("keeps the legacy fallback available outside production", () => {
    expect(() =>
      assertSmartAccountRegistryForProduction({
        nodeEnv: "test",
        smartAccountRailConfigured: true,
        hasTenantAccountRegistry: false,
        missingEnv: ["BRAIN_TENANT_ACCOUNT_REGISTRY_ADDRESS"],
      }),
    ).not.toThrow();
  });

  it("is silent in production when no smart-account rail is configured", () => {
    expect(() =>
      assertSmartAccountRegistryForProduction({
        nodeEnv: "production",
        smartAccountRailConfigured: false,
        hasTenantAccountRegistry: false,
        missingEnv: ["BRAIN_TENANT_ACCOUNT_REGISTRY_ADDRESS"],
      }),
    ).not.toThrow();
  });
});
