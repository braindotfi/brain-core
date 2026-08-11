import { describe, expect, it } from "vitest";
import { anchorCycleReason } from "./anchor-cycle.js";

const NOW = new Date("2026-08-11T12:00:00.000Z");

function decide(overrides: Partial<Parameters<typeof anchorCycleReason>[0]> = {}) {
  return anchorCycleReason({
    pendingRootCount: 0,
    eligibleRootCount: 0,
    oldestPendingAt: null,
    oldestEligibleAt: null,
    triggerTenantRoots: 50,
    maxWaitMs: 60 * 60 * 1000,
    now: NOW,
    ...overrides,
  });
}

describe("anchorCycleReason", () => {
  it("closes immediately when accumulated roots reach the configured threshold", () => {
    expect(decide({ pendingRootCount: 49, eligibleRootCount: 1 })).toBe("tenant_root_threshold");
  });

  it("closes on max wait when the threshold has not been reached", () => {
    expect(
      decide({ eligibleRootCount: 1, oldestEligibleAt: new Date("2026-08-11T11:00:00.000Z") }),
    ).toBe("max_wait_elapsed");
  });

  it("does not close before either threshold", () => {
    expect(
      decide({ eligibleRootCount: 1, oldestEligibleAt: new Date("2026-08-11T11:00:01.000Z") }),
    ).toBeNull();
  });

  it("uses the oldest pending or eligible root for max wait", () => {
    expect(
      decide({
        pendingRootCount: 1,
        eligibleRootCount: 1,
        oldestPendingAt: new Date("2026-08-11T10:30:00.000Z"),
        oldestEligibleAt: new Date("2026-08-11T11:59:59.000Z"),
      }),
    ).toBe("max_wait_elapsed");
  });
});
