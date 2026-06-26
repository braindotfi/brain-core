import { randomUUID } from "node:crypto";
import type { Proposal } from "../proposal/schema.js";
import { ProposalSchema } from "../proposal/schema.js";

/**
 * Invoice Agent: vendor_risk + payment + fraud_anomaly.
 * Example: a duplicate or mismatched vendor invoice caught before payment.
 *
 * TODO(codex): replace the input shape with the real detector output type from
 * brain-core and map every field. Do not invent monetary values, read them from
 * the source record.
 */
export interface InvoiceFinding {
  tenantId: string;
  vendorName: string;
  invoiceNumber: string;
  amountMinorUnits: number;
  currency: string;
  reason: "duplicate" | "amount_mismatch" | "fraud_anomaly";
  /** Link back to the bill in the source ERP. */
  sourceHref?: string;
  /** Opaque payload the customer ERP needs to act on the recommendation. */
  handoffPayload: Record<string, unknown>;
  approverRoles: string[];
  expiresAt: string;
}

export function buildInvoiceProposal(f: InvoiceFinding): Proposal {
  const now = new Date().toISOString();
  return ProposalSchema.parse({
    id: `inv_${randomUUID()}`,
    tenantId: f.tenantId,
    agent: "invoice",
    severity: f.reason === "fraud_anomaly" ? "critical" : "warning",
    title: `${reasonLabel(f.reason)}: ${f.vendorName} invoice ${f.invoiceNumber}`,
    claim: claimFor(f),
    evidence: [
      { label: "Vendor", value: f.vendorName },
      { label: "Invoice", value: f.invoiceNumber, ...(f.sourceHref ? { href: f.sourceHref } : {}) },
      { label: "Amount", value: money(f.amountMinorUnits, f.currency) },
      { label: "Flag", value: reasonLabel(f.reason) },
    ],
    action: {
      summary: "Hold payment and route for review before release.",
      handoff: "erp",
      payload: f.handoffPayload,
      amount: { currency: f.currency, minorUnits: f.amountMinorUnits },
    },
    policy: { gates: ["AP-DUP-001"], approverRoles: f.approverRoles, requiresDualApproval: false },
    expiresAt: f.expiresAt,
    createdAt: now,
  });
}

function reasonLabel(r: InvoiceFinding["reason"]): string {
  return r === "duplicate"
    ? "Possible duplicate"
    : r === "amount_mismatch"
      ? "Amount mismatch"
      : "Fraud anomaly";
}

function claimFor(f: InvoiceFinding): string {
  return `${f.vendorName} invoice ${f.invoiceNumber} for ${money(f.amountMinorUnits, f.currency)} was flagged as ${reasonLabel(f.reason).toLowerCase()}. Recommend holding it before payment is released.`;
}

function money(minor: number, currency: string): string {
  return `${(minor / 100).toFixed(2)} ${currency}`;
}
