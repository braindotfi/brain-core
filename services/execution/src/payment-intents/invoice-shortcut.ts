/**
 * P0.5 — invoice shortcut resolution.
 *
 * Lets a caller propose a PaymentIntent with just `{ type: "pay_invoice",
 * invoice_id }` instead of wiring every field. The resolver reads the invoice
 * (tenant-scoped — a cross-tenant id resolves to null ⇒ not_found, no existence
 * leak), derives amount/currency/counterparty/evidence, and picks the source
 * account. Every unresolved input is a specific `invoice_shortcut_*` 4xx so the
 * caller learns exactly what is missing (fail-closed).
 *
 * The gate still runs in full afterward — this only assembles the proposal.
 */

import { brainError, isBrainId, type ServiceCallContext } from "@brain/shared";

/** Invoice fields the resolver needs (subset of the Ledger Invoice). */
export interface InvoiceShortcutInvoice {
  id: string;
  counterparty_id: string;
  amount_due: string;
  amount_paid: string;
  currency: string;
  status: string;
  linked_document_ids: string[];
  linked_transaction_ids: string[];
}

export interface InvoiceShortcutDeps {
  /** Load an invoice by id under the caller's tenant. null ⇒ missing/cross-tenant. */
  resolveInvoice: (
    ctx: ServiceCallContext,
    invoiceId: string,
  ) => Promise<InvoiceShortcutInvoice | null>;
  /** Active AP (payables) bank account ids for the tenant. */
  listApAccounts: (ctx: ServiceCallContext) => Promise<string[]>;
  /** Tenant's configured default AP account id, if any. */
  resolveDefaultApAccount: (ctx: ServiceCallContext) => Promise<string | null>;
}

export interface ResolvedInvoiceShortcut {
  action_type: "ach_outbound";
  source_account_id: string;
  destination_counterparty_id: string;
  amount: string;
  currency: string;
  evidence_ids: string[];
  obligation_id?: string;
}

// The schema's invoice statuses are draft|sent|partial|paid|overdue|cancelled|
// disputed. The prompt's "open or partial" maps to the issued-and-not-fully-paid
// set; 'sent'/'overdue' are the schema's "open" equivalents.
// TODO(brain-hardening): confirm 'overdue' should be payable via the shortcut.
const PAYABLE_STATUSES = new Set(["sent", "partial", "overdue"]);

export async function resolveInvoiceShortcut(
  deps: InvoiceShortcutDeps,
  ctx: ServiceCallContext,
  invoiceId: string,
): Promise<ResolvedInvoiceShortcut> {
  if (!isBrainId(invoiceId, "inv")) {
    throw brainError("invoice_shortcut_invalid", "invoice_id malformed", {
      details: { invoice_id: invoiceId },
    });
  }

  const inv = await deps.resolveInvoice(ctx, invoiceId);
  if (inv === null) {
    throw brainError("invoice_shortcut_not_found", "invoice not found", {
      details: { invoice_id: invoiceId },
    });
  }

  if (inv.status === "paid") {
    throw brainError("invoice_shortcut_already_paid", "invoice is already fully paid", {
      details: { invoice_id: invoiceId, status: inv.status },
    });
  }
  if (!PAYABLE_STATUSES.has(inv.status)) {
    throw brainError("invoice_shortcut_not_payable", "invoice status is not payable", {
      details: { invoice_id: invoiceId, status: inv.status, payable: [...PAYABLE_STATUSES] },
    });
  }

  const amount = fromScaled8(toScaled8(inv.amount_due) - toScaled8(inv.amount_paid));
  if (toScaled8(amount) <= 0n) {
    throw brainError("invoice_shortcut_already_paid", "no balance due on invoice", {
      details: { invoice_id: invoiceId, amount_due: inv.amount_due, amount_paid: inv.amount_paid },
    });
  }

  if (inv.linked_document_ids.length === 0) {
    throw brainError("invoice_shortcut_no_evidence", "invoice has no linked document evidence", {
      details: { invoice_id: invoiceId },
    });
  }

  // Source account: single AP account ⇒ use it; otherwise the tenant default;
  // none/ambiguous-without-default ⇒ fail closed.
  const accounts = await deps.listApAccounts(ctx);
  let sourceAccountId: string;
  if (accounts.length === 1) {
    sourceAccountId = accounts[0]!;
  } else {
    const fallback = await deps.resolveDefaultApAccount(ctx);
    if (fallback === null) {
      throw brainError(
        "invoice_shortcut_source_account_unresolved",
        accounts.length === 0
          ? "tenant has no AP account to fund this payment"
          : "tenant has multiple AP accounts and no default_ap_account_id set",
        { details: { invoice_id: invoiceId, ap_account_count: accounts.length } },
      );
    }
    sourceAccountId = fallback;
  }

  // The invoice carries no direct obligation linkage (linked_transaction_ids are
  // transactions, not obligations), so obligation_id is left unset here.
  // TODO(brain-hardening): map an obligation when the invoice→obligation link exists.
  return {
    action_type: "ach_outbound",
    source_account_id: sourceAccountId,
    destination_counterparty_id: inv.counterparty_id,
    amount,
    currency: inv.currency,
    evidence_ids: inv.linked_document_ids,
  };
}

// --- exact decimal (8 dp, matching NUMERIC(28,8)) without f64 loss -----------

function toScaled8(s: string): bigint {
  const trimmed = s.trim();
  const negative = trimmed.startsWith("-");
  const body = negative ? trimmed.slice(1) : trimmed;
  const [intPart = "0", fracPart = ""] = body.split(".");
  const frac = (fracPart + "00000000").slice(0, 8);
  const v = BigInt((intPart === "" ? "0" : intPart) + frac);
  return negative ? -v : v;
}

function fromScaled8(v: bigint): string {
  const negative = v < 0n;
  const abs = (negative ? -v : v).toString().padStart(9, "0");
  const intPart = abs.slice(0, abs.length - 8);
  const fracPart = abs.slice(abs.length - 8).replace(/0+$/, "");
  const out = fracPart.length > 0 ? `${intPart}.${fracPart}` : intPart;
  return negative ? `-${out}` : out;
}
