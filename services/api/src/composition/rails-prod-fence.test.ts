import { describe, expect, it } from "vitest";
import {
  assertAtLeastOneLiveRailInProduction,
  assertEscrowRailHasStateLoader,
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
      assertEscrowRailHasStateLoader({ escrowRailLive: false, hasResolveEscrowState: false }),
    ).not.toThrow();
  });

  it("is silent when escrow rail and state loader are both wired", () => {
    expect(() =>
      assertEscrowRailHasStateLoader({ escrowRailLive: true, hasResolveEscrowState: true }),
    ).not.toThrow();
  });

  it("throws when escrow rail is live without resolveEscrowState", () => {
    expect(() =>
      assertEscrowRailHasStateLoader({ escrowRailLive: true, hasResolveEscrowState: false }),
    ).toThrow(/resolveEscrowState/);
  });
});
