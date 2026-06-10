/**
 * §6 gate — check 9.5 low-trust auto-execution refusal (Phase 2 trust
 * contract, ingestion architecture §15).
 *
 * The gate refuses an `allow` outcome (unattended execution) when the
 * supporting evidence is entirely low-trust: `customer_asserted` generic push
 * or uncorroborated `agent_contributed` document extraction. The confirm
 * (human approval) flow stays open, any higher-trust observation makes the
 * set eligible, and an obligation that reconciliation has corroborated
 * (provenance promoted to `extracted`) is eligible on document-only evidence.
 */

import { describe, expect, it } from "vitest";
import { InMemoryAuditEmitter } from "../audit/emitter.js";
import { runPreExecutionGate } from "./gate.js";
import type { ResolvedEvidence } from "./evidence-validator.js";
import type {
  GateAccount,
  GateAgent,
  GateApprovalState,
  GateCounterparty,
  GateDependencies,
  GatePaymentIntent,
  GatePolicyDecision,
  GatePrincipal,
} from "./gate.js";

const TENANT = "tnt_test";
const ACTOR = "agent_payment01";

const ACTIVE_AGENT: GateAgent = {
  id: ACTOR,
  state: "active",
  scope: { canExecutePayments: true },
  // With max_risk_level low|medium the per-rule source_trust check tolerates
  // low-trust evidence, isolating the auto-execution refusal under test.
  max_risk_level: "low",
};
const USDC_ACCOUNT: GateAccount = {
  id: "acct_X",
  status: "active",
  currency: "USD",
  available_balance: "1000.00",
};
const VENDOR_CP: GateCounterparty = {
  id: "cp_vendor",
  type: "vendor",
  risk_level: "low",
  verified_status: "document_verified",
};

const NOW = new Date();

function docEvidence(trustLevel: ResolvedEvidence["trustLevel"]): ResolvedEvidence {
  return {
    id: "prs_doc1",
    kind: "obligation_reference",
    sourceArtifactId: "raw_doc1",
    capturedAt: NOW,
    trustLevel,
    extracted: { counterparty_id: "cp_vendor", amount_due: "10.00", status: "open" },
  };
}

function baseIntent(overrides: Partial<GatePaymentIntent> = {}): GatePaymentIntent {
  return {
    id: "pi_TRUST",
    owner_id: TENANT,
    created_by_agent_id: ACTOR,
    action_type: "pay_obligation",
    source_account_id: "acct_X",
    destination_counterparty_id: "cp_vendor",
    amount: "10.00",
    currency: "USD",
    status: "approved",
    policy_decision_id: null,
    evidence_ids: ["prs_doc1"],
    obligation_id: "obl_DOC",
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<GateDependencies> = {},
  outcome: "allow" | "confirm" = "allow",
): GateDependencies {
  return {
    audit: new InMemoryAuditEmitter(),
    resolveAgent: async () => ACTIVE_AGENT,
    resolveAccount: async () => USDC_ACCOUNT,
    resolveCounterparty: async () => VENDOR_CP,
    evaluatePolicy: async (): Promise<GatePolicyDecision> => ({
      id: "pd_TRUST",
      outcome,
      matched_rule_id: "ok",
      required_approvers: outcome === "confirm" ? ["owner"] : [],
      ledger_snapshot_hash: "0xdead",
      trace: [],
    }),
    resolveApprovals: async (): Promise<GateApprovalState> => ({ signedRoles: ["owner"] }),
    ...overrides,
  };
}

const ctx = { tenantId: TENANT, actor: ACTOR };
const principal: GatePrincipal = { id: ACTOR, type: "agent", scopes: ["payment_intent:execute"] };

function run(deps: GateDependencies, intent: GatePaymentIntent) {
  return runPreExecutionGate(deps, { ctx, principal, intent });
}

describe("§6 — check 9.5 low-trust auto-execution refusal (Phase 2)", () => {
  it("fails closed on document-only evidence with an allow outcome", async () => {
    const deps = makeDeps({
      resolveEvidence: async () => [docEvidence("low")],
      resolveObligationProvenance: async () => "agent_contributed",
    });
    const result = await run(deps, baseIntent());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failedCheck.index).toBe(9.5);
      expect(result.failedCheck.name).toBe("evidence_supports_action");
      const failures = (result.failedCheck.detail as { failures: Array<{ rule: string }> })
        .failures;
      expect(failures.map((f) => f.rule)).toContain("low_trust_auto_execution");
    }
  });

  it("fails closed when no obligation-provenance loader is wired", async () => {
    const deps = makeDeps({ resolveEvidence: async () => [docEvidence("low")] });
    const result = await run(deps, baseIntent());
    expect(result.ok).toBe(false);
  });

  it("permits a corroborated obligation (provenance promoted to extracted)", async () => {
    const deps = makeDeps({
      resolveEvidence: async () => [docEvidence("low")],
      resolveObligationProvenance: async () => "extracted",
    });
    const result = await run(deps, baseIntent());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.checks.find((c) => c.index === 9.5)?.passed).toBe(true);
    }
  });

  it("leaves the confirm (human approval) flow open on document-only evidence", async () => {
    const deps = makeDeps(
      {
        resolveEvidence: async () => [docEvidence("low")],
        resolveObligationProvenance: async () => "agent_contributed",
      },
      "confirm",
    );
    const result = await run(deps, baseIntent());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.outcome).toBe("confirm");
  });

  it("permits auto-execution when a higher-trust observation also supports the action", async () => {
    const deps = makeDeps({
      resolveEvidence: async () => [
        docEvidence("low"),
        { ...docEvidence("high"), id: "prs_bank1", sourceArtifactId: "raw_bank1" },
      ],
      resolveObligationProvenance: async () => "agent_contributed",
    });
    const result = await run(deps, baseIntent());
    expect(result.ok).toBe(true);
  });
});
