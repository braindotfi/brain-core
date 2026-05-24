import { describe, expect, it } from "vitest";
import {
  validateEvidence,
  type EvidenceValidationInput,
  type ResolvedEvidence,
} from "./evidence-validator.js";

const NOW = new Date("2026-05-24T00:00:00Z");

function invoiceEvidence(overrides: Partial<ResolvedEvidence> = {}): ResolvedEvidence {
  return {
    id: "prs_inv1",
    kind: "invoice",
    sourceArtifactId: "raw_1",
    capturedAt: new Date("2026-05-01T00:00:00Z"),
    trustLevel: "high",
    extracted: {
      invoice_number: "INV-100",
      counterparty_id: "cp_acme",
      amount_due: "5000.00",
      currency: "USD",
    },
    ...overrides,
  };
}

function payInvoiceInput(
  overrides: Partial<EvidenceValidationInput> = {},
): EvidenceValidationInput {
  return {
    actionType: "pay_invoice",
    paymentIntent: {
      counterpartyId: "cp_acme",
      amount: "5000.00",
      currency: "USD",
      invoiceId: "INV-100",
    },
    evidence: [invoiceEvidence()],
    maxRiskLevel: "high",
    now: NOW,
    ...overrides,
  };
}

describe("validateEvidence — pay_invoice", () => {
  it("passes when amount/counterparty/currency/freshness/trust all match", () => {
    expect(validateEvidence(payInvoiceInput())).toEqual({ passed: true, failures: [] });
  });

  it("fails amount_match when the invoice amount differs by $0.01", () => {
    const r = validateEvidence(
      payInvoiceInput({
        evidence: [
          invoiceEvidence({ extracted: { ...invoiceEvidence().extracted, amount_due: "5000.01" } }),
        ],
      }),
    );
    expect(r.passed).toBe(false);
    expect(r.failures.map((f) => f.rule)).toContain("amount_match");
  });

  it("fails counterparty_match on a counterparty mismatch", () => {
    const r = validateEvidence(
      payInvoiceInput({
        evidence: [
          invoiceEvidence({
            extracted: { ...invoiceEvidence().extracted, counterparty_id: "cp_evil" },
          }),
        ],
      }),
    );
    expect(r.failures.map((f) => f.rule)).toContain("counterparty_match");
  });

  it("fails currency_match on a currency mismatch", () => {
    const r = validateEvidence(
      payInvoiceInput({
        evidence: [
          invoiceEvidence({ extracted: { ...invoiceEvidence().extracted, currency: "EUR" } }),
        ],
      }),
    );
    expect(r.failures.map((f) => f.rule)).toContain("currency_match");
  });

  it("fails freshness for an invoice older than the window", () => {
    const r = validateEvidence(
      payInvoiceInput({
        evidence: [invoiceEvidence({ capturedAt: new Date("2025-01-01T00:00:00Z") })],
      }),
    );
    expect(r.failures.map((f) => f.rule)).toContain("freshness");
  });

  it("fails source_trust for a low-trust source on a high-risk action", () => {
    const r = validateEvidence(
      payInvoiceInput({
        evidence: [invoiceEvidence({ trustLevel: "low" })],
        maxRiskLevel: "high",
      }),
    );
    expect(r.failures.map((f) => f.rule)).toContain("source_trust");
  });

  it("allows a low-trust source when the action's max risk is medium or lower", () => {
    const r = validateEvidence(
      payInvoiceInput({
        evidence: [invoiceEvidence({ trustLevel: "low" })],
        maxRiskLevel: "medium",
      }),
    );
    expect(r.failures.map((f) => f.rule)).not.toContain("source_trust");
  });

  it("fails invoice_present when no invoice-kind evidence is attached", () => {
    const r = validateEvidence(payInvoiceInput({ evidence: [] }));
    expect(r.failures.map((f) => f.rule)).toContain("invoice_present");
  });

  it("returns ALL failures, not just the first", () => {
    const r = validateEvidence(
      payInvoiceInput({
        evidence: [
          invoiceEvidence({
            trustLevel: "low",
            extracted: {
              invoice_number: "INV-100",
              counterparty_id: "cp_evil",
              amount_due: "1.00",
              currency: "EUR",
            },
          }),
        ],
      }),
    );
    const rules = r.failures.map((f) => f.rule);
    expect(rules).toEqual(
      expect.arrayContaining([
        "amount_match",
        "counterparty_match",
        "currency_match",
        "source_trust",
      ]),
    );
  });

  it("adversarial: a $500 invoice attached to a $50k payment fails amount_match", () => {
    const r = validateEvidence(
      payInvoiceInput({
        paymentIntent: {
          counterpartyId: "cp_acme",
          amount: "50000.00",
          currency: "USD",
          invoiceId: "INV-100",
        },
        evidence: [
          invoiceEvidence({ extracted: { ...invoiceEvidence().extracted, amount_due: "500.00" } }),
        ],
      }),
    );
    expect(r.passed).toBe(false);
    expect(r.failures.map((f) => f.rule)).toContain("amount_match");
  });
});

describe("validateEvidence — pay_obligation", () => {
  function obligationInput(over: Partial<EvidenceValidationInput> = {}): EvidenceValidationInput {
    return {
      actionType: "pay_obligation",
      paymentIntent: {
        counterpartyId: "cp_rent",
        amount: "1200.00",
        currency: "USD",
        obligationId: "obl_1",
      },
      evidence: [
        {
          id: "prs_obl",
          kind: "obligation_reference",
          sourceArtifactId: "raw_2",
          capturedAt: NOW,
          trustLevel: "high",
          extracted: { counterparty_id: "cp_rent", amount_due: "1200.00", status: "due_soon" },
        },
      ],
      maxRiskLevel: "medium",
      now: NOW,
      ...over,
    };
  }
  it("passes for a matching, open obligation reference", () => {
    expect(validateEvidence(obligationInput()).passed).toBe(true);
  });
  it("fails when the obligation is already paid", () => {
    const r = validateEvidence(
      obligationInput({
        evidence: [
          {
            id: "prs_obl",
            kind: "obligation_reference",
            sourceArtifactId: "raw_2",
            capturedAt: NOW,
            trustLevel: "high",
            extracted: { counterparty_id: "cp_rent", amount_due: "1200.00", status: "paid" },
          },
        ],
      }),
    );
    expect(r.failures.map((f) => f.rule)).toContain("obligation_status");
  });
});
