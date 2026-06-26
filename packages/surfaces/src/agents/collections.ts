import { randomUUID } from "node:crypto";
import type { Proposal } from "../proposal/schema.js";
import { ProposalSchema } from "../proposal/schema.js";

/**
 * Collections Agent: collections.
 * Example: an overdue receivable where a dunning action is recommended.
 *
 * TODO(codex): bind to the real AR aging output from brain-core. The proposed
 * dunning message text belongs in the handoff payload, not executed here.
 */
export interface CollectionsFinding {
  tenantId: string;
  customerName: string;
  invoiceNumber: string;
  daysOverdue: number;
  amountMinorUnits: number;
  currency: string;
  recommendedStep: string; // for example "send second reminder"
  sourceHref?: string;
  handoffPayload: Record<string, unknown>;
  approverRoles: string[];
  expiresAt: string;
}

export function buildCollectionsProposal(f: CollectionsFinding): Proposal {
  const now = new Date().toISOString();
  return ProposalSchema.parse({
    id: `col_${randomUUID()}`,
    tenantId: f.tenantId,
    agent: "collections",
    severity: f.daysOverdue >= 60 ? "critical" : "warning",
    title: `Overdue: ${f.customerName} invoice ${f.invoiceNumber}`,
    claim: `${f.customerName} is ${f.daysOverdue} days overdue on invoice ${f.invoiceNumber} for ${money(f.amountMinorUnits, f.currency)}. Recommend: ${f.recommendedStep}.`,
    evidence: [
      { label: "Customer", value: f.customerName },
      { label: "Invoice", value: f.invoiceNumber, ...(f.sourceHref ? { href: f.sourceHref } : {}) },
      { label: "Overdue", value: `${f.daysOverdue} days` },
      { label: "Amount", value: money(f.amountMinorUnits, f.currency) },
    ],
    action: {
      summary: f.recommendedStep,
      handoff: "email-send",
      payload: f.handoffPayload,
      amount: { currency: f.currency, minorUnits: f.amountMinorUnits },
    },
    policy: {
      gates: ["AR-DUNNING-001"],
      approverRoles: f.approverRoles,
      requiresDualApproval: false,
    },
    expiresAt: f.expiresAt,
    createdAt: now,
  });
}

function money(minor: number, currency: string): string {
  return `${(minor / 100).toFixed(2)} ${currency}`;
}
