import { randomUUID } from "node:crypto";
import type { Proposal } from "../proposal/schema.js";
import { ProposalSchema } from "../proposal/schema.js";

/**
 * Close Agent: reconciliation.
 * Example: an unreconciled item or a proposed journal adjustment at period close.
 * Usually a digest in App Home rather than a per-event push, but the proposal
 * shape is identical.
 *
 * TODO(codex): bind to the real reconciliation output. The proposed adjustment
 * is posted by the customer ledger system after approval, not by Brain.
 */
export interface CloseFinding {
  tenantId: string;
  account: string;
  discrepancyMinorUnits: number;
  currency: string;
  proposedAdjustment: string;
  sourceHref?: string;
  handoffPayload: Record<string, unknown>;
  approverRoles: string[];
  expiresAt: string;
}

export function buildCloseProposal(f: CloseFinding): Proposal {
  const now = new Date().toISOString();
  return ProposalSchema.parse({
    id: `close_${randomUUID()}`,
    tenantId: f.tenantId,
    agent: "close",
    severity: "warning",
    title: `Unreconciled: ${f.account}`,
    claim: `${f.account} shows a discrepancy of ${money(f.discrepancyMinorUnits, f.currency)}. Proposed adjustment: ${f.proposedAdjustment}.`,
    evidence: [
      { label: "Account", value: f.account, ...(f.sourceHref ? { href: f.sourceHref } : {}) },
      { label: "Discrepancy", value: money(f.discrepancyMinorUnits, f.currency) },
    ],
    action: {
      summary: f.proposedAdjustment,
      handoff: "erp",
      payload: f.handoffPayload,
      amount: { currency: f.currency, minorUnits: f.discrepancyMinorUnits },
    },
    policy: {
      gates: ["CLOSE-ADJ-001"],
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
