import { describe, expect, it } from "vitest";
import type { EvidenceBundle } from "../evidence.js";
import { subscriptionManagementDefinition } from "./definition.js";
import { subscriptionManagementHandler } from "./handler.js";

const evidence: EvidenceBundle = {
  items: [{ kind: "subscription", ref: "sub_1" }],
  completeness: 1,
  evidence_score: 1,
  missing_required_evidence: [],
  critical_missing: false,
};

describe("subscriptionManagementHandler", () => {
  for (const action of ["downgrade", "renegotiate", "cancel", "renew"] as const) {
    it(`builds ${action} proposals`, () => {
      const proposed = subscriptionManagementHandler.build({
        action,
        context: context(),
        evidence,
        definition: subscriptionManagementDefinition,
      });

      expect(proposed.channel).toBe("agent");
      if (proposed.channel === "agent") {
        expect(proposed.action).toMatchObject({
          type: "subscription_management",
          recommended_action: action,
        });
      }
    });
  }

  it("uses renew and cancel options when directory fields are absent", () => {
    const proposed = subscriptionManagementHandler.build({
      action: "renew",
      context: {
        subscription_id: "sub_1",
        merchant: "Acme SaaS",
        current_plan: "Team",
        currency: "USD",
        current_price: "1200.00",
      },
      evidence,
      definition: subscriptionManagementDefinition,
    });

    expect(proposed.channel).toBe("agent");
    if (proposed.channel === "agent") {
      expect(proposed.action).not.toHaveProperty("seats");
      expect(proposed.action.options).toEqual([
        expect.objectContaining({ label: "renew" }),
        expect.objectContaining({ label: "cancel" }),
      ]);
    }
  });

  it("marks low unchanged renewals as auto approval eligible metadata", () => {
    const proposed = subscriptionManagementHandler.build({
      action: "renew",
      context: {
        subscription_id: "sub_1",
        merchant: "Acme SaaS",
        current_plan: "Team",
        currency: "USD",
        current_price: "39.00",
        annual_price: "468.00",
        price_changed: false,
      },
      evidence,
      definition: subscriptionManagementDefinition,
    });

    expect(proposed.channel).toBe("agent");
    if (proposed.channel === "agent") {
      expect(proposed.action).toMatchObject({ auto_approval_eligible: true });
    }
  });
});

function context(): Record<string, unknown> {
  return {
    subscription_id: "sub_1",
    merchant: "Acme SaaS",
    current_plan: "Team",
    renewal_date: "2026-12-01",
    currency: "USD",
    current_price: "1200.00",
    seats: { licensed: 10, active_30d: 4, active_users: [] },
    underutilization: { percent: 60, dollar_value: "720.00" },
    options: [{ label: "downgrade", price: "480.00", seats: 4, savings_vs_current: "720.00" }],
  };
}
