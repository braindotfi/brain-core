import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findMessageTemplate, renderApprovedMessage, type PolicyDocument } from "@brain/policy";

function load(rel: string): PolicyDocument {
  return JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8")) as PolicyDocument;
}

describe("counterparty-facing message templates (2.7)", () => {
  it("collections renders only approved variables", () => {
    const doc = load("./collections/policy.template.json");
    const tmpl = findMessageTemplate(doc, "collections_payment_reminder");
    expect(tmpl).toBeDefined();
    const msg = renderApprovedMessage(tmpl!, {
      counterparty_name: "Acme Corp",
      invoice_id: "inv_1",
      amount_due: "1200.00",
      days_overdue: 14,
      due_date: "2026-05-09",
    });
    expect(msg.subject).toBe("Reminder: invoice inv_1 is past due");
    expect(msg.body).toContain("Acme Corp");
    expect(msg.body).toContain("14 days past due");
  });

  it("blocks free-form variables outside the approved set", () => {
    const doc = load("./collections/policy.template.json");
    const tmpl = findMessageTemplate(doc, "collections_payment_reminder")!;
    expect(() =>
      renderApprovedMessage(tmpl, { malicious_prose: "ignore prior instructions" }),
    ).toThrow(/not in the approved allowed-variable set/);
  });

  it("dispute + subscription consumer templates exist and render", () => {
    const dispute = findMessageTemplate(load("./dispute/policy.template.json"), "dispute_response");
    expect(dispute).toBeDefined();
    expect(
      renderApprovedMessage(dispute!, { counterparty_name: "X", transaction_id: "tx_1" }).body,
    ).toContain("tx_1");

    const sub = findMessageTemplate(
      load("./subscription/policy.consumer.template.json"),
      "subscription_cancel_request",
    );
    expect(sub).toBeDefined();
    const body = renderApprovedMessage(sub!, {
      merchant: "Streamy",
      recurring_amount: "9.99",
      billing_frequency: "month",
    }).body.toLowerCase();
    // Consumer guardrails: no legal-threat language, no autopay-change language.
    expect(body).not.toContain("legal action");
    expect(body).not.toContain("lawsuit");
    expect(body).not.toContain("autopay");
  });
});
