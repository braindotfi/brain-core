import type { EvidenceBundle } from "../src/evidence.js";
import type { GoldenScenario } from "./types.js";

const evidence: EvidenceBundle = {
  items: [
    { kind: "vendor", ref: "cp_eval_vendor", confidence: 0.95 },
    { kind: "payment_destination", ref: "cpi_eval_1", confidence: 0.95 },
    { kind: "counterparty_history", ref: "cpi_eval_1", confidence: 0.95 },
  ],
  completeness: 1,
  evidence_score: 0.95,
  missing_required_evidence: [],
  critical_missing: false,
};

export const vendorRiskScenarios = [
  scenario(
    "clear high risk new vendor with bank change",
    "Reviewed vendor risk fixture: a new unverified vendor with a recent changed bank destination should be flagged high risk and held.",
    baseContext({
      verified_status: "unverified",
      created_at: "2026-07-17T00:00:00.000Z",
      payment_destination_changed_at: "2026-07-18T00:00:00.000Z",
      prior_destination_hash: "old_hash",
      current_destination_hash: "new_hash",
    }),
    { expected_high_risk: true, risk_rank: 3 },
  ),
  scenario(
    "clear low risk established vendor",
    "Reviewed vendor risk fixture: an established document-verified vendor with stable destination history should rank lowest risk.",
    baseContext({
      counterparty_id: "cp_eval_established",
      verified_status: "document_verified",
      created_at: "2026-01-01T00:00:00.000Z",
      payment_destination_changed_at: "2026-01-01T00:00:00.000Z",
      prior_destination_hash: "stable_hash",
      current_destination_hash: "stable_hash",
      destination_name: "Eval Vendor",
    }),
    { expected_high_risk: false, risk_rank: 1 },
  ),
  scenario(
    "near threshold verify",
    "Reviewed vendor risk fixture: newly created plus unverified should trigger verification but not a high-risk hold.",
    baseContext({
      counterparty_id: "cp_eval_near",
      verified_status: "unverified",
      created_at: "2026-07-16T00:00:00.000Z",
      prior_destination_hash: "",
      current_destination_hash: "",
    }),
    { expected_high_risk: false, risk_rank: 2 },
  ),
  scenario(
    "unresolved identity holds",
    "Reviewed fail-closed fixture: unresolved vendor identity must be treated as high risk and held.",
    {
      vendor_name: "Unknown Vendor",
      identity_resolved: false,
      payment_destination_id: "cpi_unknown",
    },
    { expected_high_risk: true, risk_rank: 3 },
  ),
] as const satisfies readonly GoldenScenario[];

function scenario(
  name: string,
  rationale: string,
  context: Record<string, unknown>,
  expected: { readonly expected_high_risk: boolean; readonly risk_rank: number },
): GoldenScenario {
  return {
    agent_key: "vendor_risk",
    name,
    rationale,
    input: {
      action: "flag_vendor_risk",
      context,
      evidence,
    },
    expected,
  };
}

function baseContext(overrides: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return {
    counterparty_id: "cp_eval_vendor",
    vendor_name: "Eval Vendor",
    identity_resolved: true,
    verified_status: "document_verified",
    created_at: "2026-01-01T00:00:00.000Z",
    payment_destination_id: "cpi_eval_1",
    payment_destination_changed_at: "2026-01-01T00:00:00.000Z",
    prior_destination_hash: "stable_hash",
    current_destination_hash: "stable_hash",
    destination_name: "Eval Vendor",
    ...overrides,
  };
}
