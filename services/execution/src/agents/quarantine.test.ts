/**
 * H-09 agent contribution hold tests.
 *
 * NOTE: the spec's prose test ("6th, no release → quarantined") contradicts its
 * own concrete ingest rule (`contribution_count <= quarantine_threshold` →
 * quarantine) and the problem statement ("auto-approve AFTER threshold"). We
 * implement the explicit rule: the first `threshold` contributions are held;
 * once over the threshold (or after release) they extract. Flagged in the H-09
 * summary.
 */

import { describe, expect, it, vi } from "vitest";
import type { TenantScopedClient } from "@brain/shared";
import {
  shouldQuarantineContribution,
  recordContributionAndDecide,
  releaseContributionHold,
} from "./quarantine.js";

describe("shouldQuarantineContribution", () => {
  it("quarantines the first N (count ≤ threshold, not released)", () => {
    for (let n = 1; n <= 5; n += 1) {
      expect(
        shouldQuarantineContribution({
          contributionCount: n,
          quarantineThreshold: 5,
          contributionHoldClearedAt: null,
        }),
      ).toBe(true);
    }
  });

  it("auto-approves once over the threshold (count > threshold)", () => {
    expect(
      shouldQuarantineContribution({
        contributionCount: 6,
        quarantineThreshold: 5,
        contributionHoldClearedAt: null,
      }),
    ).toBe(false);
  });

  it("never quarantines once released, even within the threshold", () => {
    expect(
      shouldQuarantineContribution({
        contributionCount: 2,
        quarantineThreshold: 5,
        contributionHoldClearedAt: new Date(),
      }),
    ).toBe(false);
  });
});

function fakeClient(handler: (sql: string, values: unknown[]) => unknown[]): TenantScopedClient {
  return {
    query: vi.fn(async (sql: string, values: unknown[] = []) => {
      const rows = handler(sql, values);
      return { rows, rowCount: rows.length };
    }),
  } as unknown as TenantScopedClient;
}

describe("recordContributionAndDecide", () => {
  it("increments the counter and quarantines an early contribution", async () => {
    const c = fakeClient((sql) =>
      sql.includes("UPDATE agents")
        ? [
            {
              contribution_count: 3,
              quarantine_threshold: 5,
              contribution_hold_cleared_at: null,
            },
          ]
        : [],
    );
    const r = await recordContributionAndDecide(c, "agent_1");
    expect(r).toEqual({ quarantined: true, contributionCount: 3 });
  });

  it("does not quarantine once released", async () => {
    const c = fakeClient(() => [
      {
        contribution_count: 2,
        quarantine_threshold: 5,
        contribution_hold_cleared_at: new Date(),
      },
    ]);
    const r = await recordContributionAndDecide(c, "agent_1");
    expect(r?.quarantined).toBe(false);
  });

  it("returns null for an unknown / cross-tenant agent (RLS hid the row)", async () => {
    const c = fakeClient(() => []);
    expect(await recordContributionAndDecide(c, "agent_other")).toBeNull();
  });
});

describe("releaseContributionHold", () => {
  it("returns true when the agent's contribution hold is cleared", async () => {
    const c = fakeClient((sql) => (sql.includes("UPDATE agents") ? [{ id: "agent_1" }] : []));
    expect(await releaseContributionHold(c, "agent_1")).toBe(true);
  });

  it("returns false (→ 404) for a cross-tenant agent", async () => {
    const c = fakeClient(() => []);
    expect(await releaseContributionHold(c, "agent_b")).toBe(false);
  });
});
