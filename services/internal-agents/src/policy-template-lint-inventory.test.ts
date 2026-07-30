/**
 * Inventory of lintPolicy ERROR findings each internal-agent policy template
 * currently produces (H-18 follow-up).
 *
 * After routes.ts sign was changed to reject activation on ANY lintPolicy
 * ERROR finding (not only the confidence-floor codes), NONE of these 18
 * shipped `policy.template.json` reference templates are currently
 * activatable through `POST /policy/:tenant_id/sign`. Several declare
 * `applies_to: ["any", ...]` with `execute: "auto"` (e.g. revenue_intel,
 * reconciliation) -- a true positive, since `any` matches outbound_payment in
 * the VM, so those templates really would auto-approve a payment with no
 * amount cap, no counterparty allowlist, and no risk bound.
 *
 * Narrowing each agent's authority envelope so its template actually
 * activates is a product decision, out of scope for the change that added
 * this inventory. This test exists so the list shrinks deliberately (someone
 * narrows a template and updates its expected codes here) rather than
 * drifting silently forever. If a template's actual findings no longer match
 * the expected set below, that is either a real narrowing (update the
 * expectation) or a regression in lintPolicy itself (investigate).
 */

import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lintPolicy, type PolicyDocument } from "@brain/policy";

const TEMPLATES_DIR = new URL("./", import.meta.url);

function loadTemplate(agent: string): PolicyDocument {
  return JSON.parse(
    readFileSync(new URL(`./${agent}/policy.template.json`, import.meta.url), "utf8"),
  ) as PolicyDocument;
}

/** Every agent directory that ships a policy.template.json. */
function agentsWithTemplates(): string[] {
  const dir = readdirSync(new URL(".", TEMPLATES_DIR), { withFileTypes: true });
  return dir
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => {
      try {
        readFileSync(new URL(`./${name}/policy.template.json`, import.meta.url));
        return true;
      } catch {
        return false;
      }
    })
    .sort();
}

// Exact ERROR code set each template produces today, under the same
// enforcement options routes.ts sign uses for a production tenant
// (confidenceFloorReject: true). Sorted, deduplicated.
const EXPECTED_ERROR_CODES: Readonly<Record<string, readonly string[]>> = {
  bill_management: [
    "auto_no_counterparty_constraint",
    "auto_no_risk_bound",
    "auto_no_verified_counterparty",
    "confidence_floor_missing",
  ],
  cash_forecast: [
    "auto_no_amount_cap",
    "auto_no_counterparty_constraint",
    "auto_no_risk_bound",
    "auto_no_verified_counterparty",
    "broad_any_auto",
    "confidence_floor_missing",
    "no_approval_path_high_value",
  ],
  collections: [
    "auto_no_amount_cap",
    "auto_no_counterparty_constraint",
    "auto_no_risk_bound",
    "auto_no_verified_counterparty",
    "broad_any_auto",
    "confidence_floor_missing",
    "no_approval_path_high_value",
  ],
  compliance: ["confidence_floor_missing", "invalid_approval_role"],
  debt_optimization: [
    "auto_no_counterparty_constraint",
    "auto_no_risk_bound",
    "auto_no_verified_counterparty",
    "confidence_floor_missing",
  ],
  dispute: [
    "auto_no_amount_cap",
    "auto_no_counterparty_constraint",
    "auto_no_risk_bound",
    "auto_no_verified_counterparty",
    "broad_any_auto",
    "confidence_floor_missing",
    "no_approval_path_high_value",
  ],
  financial_health: [
    "auto_no_amount_cap",
    "auto_no_counterparty_constraint",
    "auto_no_risk_bound",
    "auto_no_verified_counterparty",
    "broad_any_auto",
    "confidence_floor_missing",
    "no_approval_path_high_value",
  ],
  fraud_anomaly: ["confidence_floor_missing", "invalid_approval_role"],
  payment: [
    "auto_no_counterparty_constraint",
    "auto_no_risk_bound",
    "auto_no_verified_counterparty",
    "confidence_floor_missing",
  ],
  personal_budget: [
    "auto_no_amount_cap",
    "auto_no_counterparty_constraint",
    "auto_no_risk_bound",
    "auto_no_verified_counterparty",
    "broad_any_auto",
    "confidence_floor_missing",
    "no_approval_path_high_value",
  ],
  purchase_advisor: [
    "auto_no_amount_cap",
    "auto_no_counterparty_constraint",
    "auto_no_risk_bound",
    "auto_no_verified_counterparty",
    "broad_any_auto",
    "confidence_floor_missing",
    "no_approval_path_high_value",
  ],
  reconciliation: [
    "auto_no_amount_cap",
    "auto_no_counterparty_constraint",
    "auto_no_risk_bound",
    "auto_no_verified_counterparty",
    "broad_any_auto",
    "confidence_floor_missing",
    "no_approval_path_high_value",
  ],
  revenue_intel: [
    "auto_no_amount_cap",
    "auto_no_counterparty_constraint",
    "auto_no_risk_bound",
    "auto_no_verified_counterparty",
    "broad_any_auto",
    "confidence_floor_missing",
    "no_approval_path_high_value",
  ],
  savings: [
    "auto_no_counterparty_constraint",
    "auto_no_risk_bound",
    "auto_no_verified_counterparty",
    "confidence_floor_missing",
  ],
  subscription: [
    "auto_no_amount_cap",
    "auto_no_counterparty_constraint",
    "auto_no_risk_bound",
    "auto_no_verified_counterparty",
    "broad_any_auto",
    "confidence_floor_missing",
    "no_approval_path_high_value",
  ],
  tax_prep: [
    "auto_no_amount_cap",
    "auto_no_counterparty_constraint",
    "auto_no_risk_bound",
    "auto_no_verified_counterparty",
    "broad_any_auto",
    "confidence_floor_missing",
    "no_approval_path_high_value",
  ],
  travel_finance: [
    "auto_no_amount_cap",
    "auto_no_counterparty_constraint",
    "auto_no_risk_bound",
    "auto_no_verified_counterparty",
    "broad_any_auto",
    "confidence_floor_missing",
    "no_approval_path_high_value",
  ],
  treasury: [
    "auto_no_counterparty_constraint",
    "auto_no_risk_bound",
    "auto_no_verified_counterparty",
    "confidence_floor_missing",
  ],
  vendor_risk: ["confidence_floor_missing", "invalid_approval_role"],
};

describe("policy.template.json lint-error inventory (H-18 follow-up, not a pass/fail gate on new agents)", () => {
  it("every agent directory with a template is covered by the expectation table", () => {
    expect(agentsWithTemplates().sort()).toEqual(Object.keys(EXPECTED_ERROR_CODES).sort());
  });

  for (const [agent, expectedCodes] of Object.entries(EXPECTED_ERROR_CODES)) {
    it(`${agent}: matches its recorded ERROR-finding inventory`, () => {
      const doc = loadTemplate(agent);
      const findings = lintPolicy(doc, { confidenceFloorReject: true });
      const actualCodes = [
        ...new Set(findings.filter((f) => f.severity === "ERROR").map((f) => f.code)),
      ].sort();
      expect(actualCodes).toEqual([...expectedCodes].sort());
    });
  }
});
