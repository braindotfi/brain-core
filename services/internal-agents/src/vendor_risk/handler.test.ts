import { describe, expect, it } from "vitest";
import type { EvidenceBundle } from "../evidence.js";
import { vendorRiskHandler } from "./handler.js";

const evidence: EvidenceBundle = {
  items: [
    { kind: "vendor", ref: "cp_vendor_1", confidence: 0.9 },
    { kind: "payment_destination", ref: "cpi_1", confidence: 0.9 },
    { kind: "counterparty_history", ref: "cpi_1", confidence: 0.9 },
  ],
  completeness: 1,
  evidence_score: 0.9,
  missing_required_evidence: [],
  critical_missing: false,
};

describe("vendorRiskHandler", () => {
  it("holds a new unverified vendor with a recent bank detail change", () => {
    const proposed = vendorRiskHandler.build({
      action: "flag_vendor_risk",
      now: new Date("2026-07-18T00:00:00.000Z"),
      context: {
        counterparty_id: "cp_vendor_1",
        vendor_name: "Acme Supplies",
        verified_status: "unverified",
        created_at: "2026-07-17T00:00:00.000Z",
        payment_destination_id: "cpi_1",
        payment_destination_changed_at: "2026-07-18T00:00:00.000Z",
        prior_destination_hash: "old_hash",
        current_destination_hash: "new_hash",
      },
      evidence,
    });

    expect(proposed.channel).toBe("agent");
    if (proposed.channel === "agent") {
      expect(proposed.action).toMatchObject({
        type: "block_payment",
        risk_band: "high",
        risk_score: 1,
        recommended_action: "hold",
        triggering_signals: ["unverified_identity"],
      });
    }
  });

  it("allows an established verified vendor with stable destination history", () => {
    const proposed = vendorRiskHandler.build({
      action: "flag_vendor_risk",
      now: new Date("2026-07-18T00:00:00.000Z"),
      context: {
        counterparty_id: "cp_vendor_2",
        vendor_name: "Known Vendor",
        verified_status: "document_verified",
        created_at: "2026-01-01T00:00:00.000Z",
        payment_destination_id: "cpi_2",
        payment_destination_changed_at: "2026-01-01T00:00:00.000Z",
        prior_destination_hash: "stable_hash",
        current_destination_hash: "stable_hash",
        destination_name: "Known Vendor",
      },
      evidence,
    });

    expect(proposed.channel).toBe("agent");
    if (proposed.channel === "agent") {
      expect(proposed.action).toMatchObject({
        type: "flag_vendor_risk",
        risk_band: "standard",
        risk_score: 0,
        recommended_action: "allow",
        triggering_signals: [],
      });
    }
  });

  it("hard-holds a near-threshold unverified vendor", () => {
    const proposed = vendorRiskHandler.build({
      action: "require_approval",
      now: new Date("2026-07-18T00:00:00.000Z"),
      context: {
        counterparty_id: "cp_vendor_3",
        vendor_name: "New Vendor",
        verified_status: "unverified",
        created_at: "2026-07-16T00:00:00.000Z",
        payment_destination_id: "cpi_3",
      },
      evidence,
    });

    expect(proposed.channel).toBe("agent");
    if (proposed.channel === "agent") {
      expect(proposed.action).toMatchObject({
        type: "block_payment",
        risk_band: "high",
        risk_score: 1,
        recommended_action: "hold",
        triggering_signals: ["unverified_identity"],
      });
    }
  });

  it("scores a verified vendor with a bank detail change through graduated signals", () => {
    const proposed = vendorRiskHandler.build({
      action: "flag_vendor_risk",
      now: new Date("2026-07-18T00:00:00.000Z"),
      context: {
        counterparty_id: "cp_vendor_4",
        vendor_name: "Known Vendor",
        identity_resolved: true,
        verified_status: "document_verified",
        created_at: "2026-01-01T00:00:00.000Z",
        payment_destination_id: "cpi_4",
        payment_destination_changed_at: "2026-07-18T00:00:00.000Z",
        prior_destination_hash: "old_hash",
        current_destination_hash: "new_hash",
        destination_name: "Known Vendor",
      },
      evidence,
    });

    expect(proposed.channel).toBe("agent");
    if (proposed.channel === "agent") {
      expect(proposed.action).toMatchObject({
        type: "flag_vendor_risk",
        risk_band: "elevated",
        risk_score: 0.6,
        recommended_action: "verify",
        triggering_signals: ["recent_bank_detail_change", "destination_changed_vs_history"],
      });
    }
  });

  it("fails closed to hold when identity is unresolved", () => {
    const proposed = vendorRiskHandler.build({
      action: "flag_vendor_risk",
      now: new Date("2026-07-18T00:00:00.000Z"),
      context: {
        vendor_name: "Unknown Vendor",
        identity_resolved: false,
        payment_destination_id: "cpi_missing",
      },
      evidence,
    });

    expect(proposed.channel).toBe("agent");
    if (proposed.channel === "agent") {
      expect(proposed.action).toMatchObject({
        type: "block_payment",
        vendor_id: null,
        risk_band: "high",
        risk_score: 1,
        recommended_action: "hold",
        triggering_signals: ["identity_unresolved"],
      });
    }
  });
});
