import { describe, expect, it } from "vitest";
import type { PaymentIntent, PaymentIntentStatus } from "@brain/shared";
import { paymentIntentToAction, piStatusToActionStatus, piStatusToDecision } from "./mapper.js";

function fakeIntent(status: PaymentIntentStatus): PaymentIntent {
  return {
    id: "pi_abc",
    owner_id: "tnt_acme",
    created_by_agent_id: "ag_payments",
    action_type: "ach_outbound",
    source_account_id: "acct_1",
    destination_counterparty_id: "cp_1",
    amount: "100.00",
    currency: "USD",
    obligation_id: null,
    invoice_id: null,
    status,
    policy_decision_id: "pd_1",
    approval_ids: [],
    execution_receipt_ids: [],
    source_ids: [],
    evidence_ids: [],
    provenance: "extracted",
    confidence: 1,
    created_at: "2026-05-15T10:00:00Z",
    updated_at: "2026-05-15T10:00:00Z",
  };
}

describe("piStatusToActionStatus", () => {
  it("collapses proposed + approved to auto", () => {
    expect(piStatusToActionStatus("proposed")).toBe("auto");
    expect(piStatusToActionStatus("approved")).toBe("auto");
  });

  it("maps pending_approval to needs_approval", () => {
    expect(piStatusToActionStatus("pending_approval")).toBe("needs_approval");
  });

  it("preserves terminal statuses verbatim", () => {
    expect(piStatusToActionStatus("rejected")).toBe("rejected");
    expect(piStatusToActionStatus("executed")).toBe("executed");
    expect(piStatusToActionStatus("failed")).toBe("failed");
    expect(piStatusToActionStatus("cancelled")).toBe("cancelled");
  });
});

describe("piStatusToDecision", () => {
  it("maps rejected → DENY", () => {
    expect(piStatusToDecision("rejected")).toBe("DENY");
  });
  it("maps pending_approval → ESCALATE", () => {
    expect(piStatusToDecision("pending_approval")).toBe("ESCALATE");
  });
  it("maps every other lifecycle state to ALLOW", () => {
    const allowed: PaymentIntentStatus[] = [
      "proposed",
      "approved",
      "executed",
      "failed",
      "cancelled",
    ];
    for (const s of allowed) {
      expect(piStatusToDecision(s)).toBe("ALLOW");
    }
  });
});

describe("paymentIntentToAction", () => {
  it("emits the docs Action shape with both translated fields", () => {
    const action = paymentIntentToAction(fakeIntent("approved"));
    expect(action.id).toBe("pi_abc");
    expect(action.tenantId).toBe("tnt_acme");
    expect(action.type).toBe("ach_outbound");
    expect(action.status).toBe("auto");
    expect(action.decision).toBe("ALLOW");
    expect(action.agent_id).toBe("ag_payments");
  });

  it("emits decision=DENY when status=rejected", () => {
    const action = paymentIntentToAction(fakeIntent("rejected"));
    expect(action.decision).toBe("DENY");
    expect(action.status).toBe("rejected");
  });

  it("emits decision=ESCALATE when status=pending_approval", () => {
    const action = paymentIntentToAction(fakeIntent("pending_approval"));
    expect(action.decision).toBe("ESCALATE");
    expect(action.status).toBe("needs_approval");
  });

  it("synthesizes expires_at 24h after updated_at", () => {
    const action = paymentIntentToAction(fakeIntent("approved"));
    // 2026-05-15T10:00:00Z + 24h = 2026-05-16T10:00:00Z
    expect(action.expires_at).toBe("2026-05-16T10:00:00.000Z");
  });

  it("never leaks the storage `owner_id` field — uses `tenantId` instead", () => {
    const action = paymentIntentToAction(fakeIntent("executed"));
    expect(Object.keys(action)).not.toContain("owner_id");
    expect(action.tenantId).toBe("tnt_acme");
  });
});
