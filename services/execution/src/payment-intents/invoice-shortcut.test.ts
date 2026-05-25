/**
 * P0.5 — invoice shortcut resolver unit tests (hermetic; injected lookups).
 */

import { describe, expect, it } from "vitest";
import { newInvoiceId, newTenantId, type ServiceCallContext } from "@brain/shared";
import {
  resolveInvoiceShortcut,
  type InvoiceShortcutDeps,
  type InvoiceShortcutInvoice,
} from "./invoice-shortcut.js";

const INV = newInvoiceId();
const ctx: ServiceCallContext = { tenantId: newTenantId(), actor: "user_x" };

function invoice(over: Partial<InvoiceShortcutInvoice> = {}): InvoiceShortcutInvoice {
  return {
    id: INV,
    counterparty_id: "cp_1",
    amount_due: "100.00",
    amount_paid: "0",
    currency: "USD",
    status: "sent",
    linked_document_ids: ["doc_1"],
    linked_transaction_ids: [],
    ...over,
  };
}

function deps(over: Partial<InvoiceShortcutDeps> = {}): InvoiceShortcutDeps {
  return {
    resolveInvoice: async () => invoice(),
    listApAccounts: async () => ["acct_ap1"],
    resolveDefaultApAccount: async () => null,
    ...over,
  };
}

describe("resolveInvoiceShortcut (P0.5)", () => {
  it("happy path: derives amount, currency, counterparty, evidence, source account", async () => {
    const r = await resolveInvoiceShortcut(deps(), ctx, INV);
    expect(r.amount).toBe("100");
    expect(r.currency).toBe("USD");
    expect(r.destination_counterparty_id).toBe("cp_1");
    expect(r.evidence_ids).toEqual(["doc_1"]);
    expect(r.source_account_id).toBe("acct_ap1");
    expect(r.action_type).toBe("ach_outbound");
  });

  it("computes amount_due - amount_paid for a partial invoice", async () => {
    const r = await resolveInvoiceShortcut(
      deps({ resolveInvoice: async () => invoice({ status: "partial", amount_paid: "30.00" }) }),
      ctx,
      INV,
    );
    expect(r.amount).toBe("70");
  });

  it("multiple AP accounts uses the tenant default", async () => {
    const r = await resolveInvoiceShortcut(
      deps({
        listApAccounts: async () => ["acct_a", "acct_b"],
        resolveDefaultApAccount: async () => "acct_b",
      }),
      ctx,
      INV,
    );
    expect(r.source_account_id).toBe("acct_b");
  });

  it("fails closed: malformed invoice id → invoice_shortcut_invalid", async () => {
    await expect(resolveInvoiceShortcut(deps(), ctx, "not-an-invoice")).rejects.toMatchObject({
      code: "invoice_shortcut_invalid",
    });
  });

  it("fails closed: not found (also covers cross-tenant id) → invoice_shortcut_not_found", async () => {
    await expect(
      resolveInvoiceShortcut(deps({ resolveInvoice: async () => null }), ctx, INV),
    ).rejects.toMatchObject({ code: "invoice_shortcut_not_found" });
  });

  it("fails closed: fully-paid status → invoice_shortcut_already_paid", async () => {
    await expect(
      resolveInvoiceShortcut(
        deps({ resolveInvoice: async () => invoice({ status: "paid" }) }),
        ctx,
        INV,
      ),
    ).rejects.toMatchObject({ code: "invoice_shortcut_already_paid" });
  });

  it("fails closed: zero balance due → invoice_shortcut_already_paid", async () => {
    await expect(
      resolveInvoiceShortcut(
        deps({
          resolveInvoice: async () => invoice({ amount_due: "50.00", amount_paid: "50.00" }),
        }),
        ctx,
        INV,
      ),
    ).rejects.toMatchObject({ code: "invoice_shortcut_already_paid" });
  });

  it("fails closed: non-payable status (draft) → invoice_shortcut_not_payable", async () => {
    await expect(
      resolveInvoiceShortcut(
        deps({ resolveInvoice: async () => invoice({ status: "draft" }) }),
        ctx,
        INV,
      ),
    ).rejects.toMatchObject({ code: "invoice_shortcut_not_payable" });
  });

  it("fails closed: no linked evidence → invoice_shortcut_no_evidence", async () => {
    await expect(
      resolveInvoiceShortcut(
        deps({ resolveInvoice: async () => invoice({ linked_document_ids: [] }) }),
        ctx,
        INV,
      ),
    ).rejects.toMatchObject({ code: "invoice_shortcut_no_evidence" });
  });

  it("fails closed: no AP account and no default → invoice_shortcut_source_account_unresolved", async () => {
    await expect(
      resolveInvoiceShortcut(
        deps({ listApAccounts: async () => [], resolveDefaultApAccount: async () => null }),
        ctx,
        INV,
      ),
    ).rejects.toMatchObject({ code: "invoice_shortcut_source_account_unresolved" });
  });
});
