import { randomUUID } from "node:crypto";
import type { Proposal } from "../proposal/schema.js";
import { ProposalSchema } from "../proposal/schema.js";

/**
 * Cash Agent: treasury + cash_forecast.
 * Example: idle balance that could be swept, or a forecast shortfall to cover.
 * Higher policy stakes, so dual approval defaults on above a configured amount.
 *
 * TODO(codex): bind to the real treasury forecast output. The sweep instruction
 * lives in the handoff payload and is executed by the customer bank rail, never
 * by Brain.
 */
export interface CashFinding {
  tenantId: string;
  kind: "sweep_idle" | "cover_shortfall";
  fromAccount: string;
  toAccount: string;
  amountMinorUnits: number;
  currency: string;
  rationale: string;
  dualApprovalThresholdMinorUnits: number;
  handoffPayload: Record<string, unknown>;
  approverRoles: string[];
  expiresAt: string;
}

export function buildCashProposal(f: CashFinding): Proposal {
  const now = new Date().toISOString();
  const dual = f.amountMinorUnits >= f.dualApprovalThresholdMinorUnits;
  return ProposalSchema.parse({
    id: `cash_${randomUUID()}`,
    tenantId: f.tenantId,
    agent: "cash",
    severity: f.kind === "cover_shortfall" ? "critical" : "info",
    title:
      f.kind === "sweep_idle"
        ? `Idle cash: move ${money(f.amountMinorUnits, f.currency)}`
        : `Shortfall: cover ${money(f.amountMinorUnits, f.currency)}`,
    claim: `${f.rationale} Recommend moving ${money(f.amountMinorUnits, f.currency)} from ${f.fromAccount} to ${f.toAccount}.`,
    evidence: [
      { label: "From", value: f.fromAccount },
      { label: "To", value: f.toAccount },
      { label: "Amount", value: money(f.amountMinorUnits, f.currency) },
    ],
    action: {
      summary: `Move ${money(f.amountMinorUnits, f.currency)} from ${f.fromAccount} to ${f.toAccount}.`,
      handoff: "bank-portal",
      payload: f.handoffPayload,
      amount: { currency: f.currency, minorUnits: f.amountMinorUnits },
    },
    policy: {
      gates: ["TREAS-MOVE-001"],
      approverRoles: f.approverRoles,
      requiresDualApproval: dual,
    },
    expiresAt: f.expiresAt,
    createdAt: now,
  });
}

function money(minor: number, currency: string): string {
  return `${(minor / 100).toFixed(2)} ${currency}`;
}
