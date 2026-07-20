import { describe, expect, it } from "vitest";
import type { EvidenceBundle } from "../evidence.js";
import { paymentHandler } from "./handler.js";

const EVIDENCE: EvidenceBundle = {
  items: [
    { kind: "invoice", ref: "inv_1" },
    { kind: "counterparty", ref: "cp_1" },
  ],
  completeness: 1,
  evidence_score: 1,
  missing_required_evidence: [],
  critical_missing: false,
};

const LOW_EVIDENCE: EvidenceBundle = {
  ...EVIDENCE,
  evidence_score: 0.42,
};

describe("paymentHandler — ACH branch", () => {
  it("emits ach_outbound when rail is absent", () => {
    const proposed = paymentHandler.build({
      action: "propose_payment",
      context: {
        source_account_id: "acct_1",
        destination_counterparty_id: "cp_2",
        amount: "100",
        currency: "USD",
      },
      evidence: EVIDENCE,
    });
    expect(proposed.channel).toBe("payment_intent");
    if (proposed.channel !== "payment_intent") return;
    expect(proposed.intent.action_type).toBe("ach_outbound");
    expect(proposed.intent.source_account_id).toBe("acct_1");
    expect(proposed.intent.destination_counterparty_id).toBe("cp_2");
    expect(proposed.intent.amount).toBe("100");
    expect(proposed.intent.currency).toBe("USD");
    expect(proposed.intent.evidence_ids).toEqual(["inv_1", "cp_1"]);
    expect(proposed.intent.confidence).toBe(1);
  });

  it("sets intent confidence from the evidence score", () => {
    const proposed = paymentHandler.build({
      action: "propose_payment",
      context: {
        source_account_id: "acct_1",
        destination_counterparty_id: "cp_2",
        amount: "100",
        currency: "USD",
      },
      evidence: LOW_EVIDENCE,
    });

    expect(proposed.channel).toBe("payment_intent");
    if (proposed.channel !== "payment_intent") return;
    expect(proposed.intent.confidence).toBe(0.42);
  });

  it("rejects missing ids and malformed money fields before creating an intent shape", () => {
    expect(() =>
      paymentHandler.build({
        action: "propose_payment",
        context: {
          source_account_id: "acct_1",
          amount: "100",
          currency: "USD",
        },
        evidence: EVIDENCE,
      }),
    ).toThrow(/destination_counterparty_id/);

    expect(() =>
      paymentHandler.build({
        action: "propose_payment",
        context: {
          source_account_id: "acct_1",
          destination_counterparty_id: "cp_2",
          amount: 100,
          currency: "USD",
        },
        evidence: EVIDENCE,
      }),
    ).toThrow(/amount/);

    expect(() =>
      paymentHandler.build({
        action: "propose_payment",
        context: {
          source_account_id: "acct_1",
          destination_counterparty_id: "cp_2",
          amount: "100",
          currency: 840,
        },
        evidence: EVIDENCE,
      }),
    ).toThrow(/currency/);
  });

  it("emits ach_outbound when rail is 'ach'", () => {
    const proposed = paymentHandler.build({
      action: "execute_payment",
      context: {
        rail: "ach",
        source_account_id: "acct_1",
        destination_counterparty_id: "cp_2",
        amount: "500",
        currency: "USD",
      },
      evidence: EVIDENCE,
    });
    expect(proposed.channel).toBe("payment_intent");
    if (proposed.channel !== "payment_intent") return;
    expect(proposed.intent.action_type).toBe("ach_outbound");
  });

  it("forwards invoice_id when present", () => {
    const proposed = paymentHandler.build({
      action: "propose_payment",
      context: {
        source_account_id: "acct_1",
        destination_counterparty_id: "cp_2",
        amount: "250",
        currency: "USD",
        invoice_id: "inv_xyz",
      },
      evidence: EVIDENCE,
    });
    expect(proposed.channel).toBe("payment_intent");
    if (proposed.channel !== "payment_intent") return;
    expect(proposed.intent.invoice_id).toBe("inv_xyz");
  });
});

describe("paymentHandler — on-chain branch", () => {
  it("emits onchain_transfer when rail is 'onchain'", () => {
    const proposed = paymentHandler.build({
      action: "execute_payment",
      context: {
        rail: "onchain",
        source_account_id: "acct_wallet",
        destination_counterparty_id: "cp_wallet",
        amount: "0.01",
        currency: "ETH",
      },
      evidence: EVIDENCE,
    });
    expect(proposed.channel).toBe("payment_intent");
    if (proposed.channel !== "payment_intent") return;
    expect(proposed.intent.action_type).toBe("onchain_transfer");
    expect(proposed.intent.source_account_id).toBe("acct_wallet");
    expect(proposed.intent.destination_counterparty_id).toBe("cp_wallet");
    expect(proposed.intent.amount).toBe("0.01");
    expect(proposed.intent.currency).toBe("ETH");
  });

  it("emits onchain_transfer for schedule_payment with onchain rail", () => {
    const proposed = paymentHandler.build({
      action: "schedule_payment",
      context: {
        rail: "onchain",
        source_account_id: "acct_wallet",
        destination_counterparty_id: "cp_wallet",
        amount: "1",
        currency: "ETH",
      },
      evidence: EVIDENCE,
    });
    expect(proposed.channel).toBe("payment_intent");
    if (proposed.channel !== "payment_intent") return;
    expect(proposed.intent.action_type).toBe("onchain_transfer");
  });
});

describe("paymentHandler — advisory action", () => {
  it("ranks urgent payable advisory without creating a payment intent", () => {
    const proposed = paymentHandler.build({
      action: "request_approval",
      context: {
        source_account_id: "acct_1",
        currency: "USD",
        available_cash: "10000.00",
        payables: [
          {
            obligation_id: "obl_later",
            counterparty_id: "cp_later",
            amount: "100.00",
            currency: "USD",
            due_date: "2026-08-20T00:00:00.000Z",
          },
          {
            obligation_id: "obl_now",
            counterparty_id: "cp_now",
            amount: "200.00",
            currency: "USD",
            due_date: "2026-07-20T00:00:00.000Z",
          },
        ],
      },
      evidence: EVIDENCE,
      now: new Date("2026-07-18T00:00:00.000Z"),
    });
    expect(proposed.channel).toBe("agent");
    if (proposed.channel !== "agent") return;
    expect(proposed.action.obligation_id).toBe("obl_now");
    expect(proposed.action.recommended_payment_decision).toBe("pay_now");
    expect(proposed.action.ranked_payables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ obligation_id: "obl_now", decision: "pay_now" }),
        expect.objectContaining({ obligation_id: "obl_later", decision: "defer" }),
      ]),
    );
  });

  it("defers low-priority payable advisory", () => {
    const proposed = paymentHandler.build({
      action: "request_approval",
      context: {
        source_account_id: "acct_1",
        currency: "USD",
        available_cash: "10000.00",
        obligation_id: "obl_later",
        counterparty_id: "cp_later",
        amount: "100.00",
        due_date: "2026-09-20T00:00:00.000Z",
      },
      evidence: EVIDENCE,
      now: new Date("2026-07-18T00:00:00.000Z"),
    });

    expect(proposed.channel).toBe("agent");
    if (proposed.channel !== "agent") return;
    expect(proposed.action.recommended_payment_decision).toBe("defer");
  });

  it("fails closed when payable context is missing", () => {
    expect(() =>
      paymentHandler.build({
        action: "request_approval",
        context: {
          source_account_id: "acct_1",
          currency: "USD",
        },
        evidence: EVIDENCE,
      }),
    ).toThrow(/obligation_id/);
  });
});
