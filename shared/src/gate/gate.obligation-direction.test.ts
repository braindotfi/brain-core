/**
 * §6 gate -- check 6.7: obligation direction matches flow (batch 10 H-1).
 *
 * The deterministic gate rejects an outflow payment-intent whose linked
 * obligation is a receivable (money owed TO us). This closes the "AR drain"
 * footgun the doc_obligation_v1 parser always knew about (the parser carries
 * a `direction` field) but the obligations table never persisted before H-1.
 *
 * Dormant-until-wired: when the loader is unwired or the intent carries no
 * obligation_id, the check adds no row and the canonical happy path is
 * unchanged. Wired + payable / NULL = pass; wired + receivable = HARD FAIL.
 */

import { describe, expect, it } from "vitest";
import { InMemoryAuditEmitter } from "../audit/emitter.js";
import { runPreExecutionGate } from "./gate.js";
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

const ACTIVE_AGENT: GateAgent = { id: ACTOR, state: "active", scope: { canExecutePayments: true } };
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

function baseIntent(overrides: Partial<GatePaymentIntent> = {}): GatePaymentIntent {
  return {
    id: "pi_OBL",
    owner_id: TENANT,
    created_by_agent_id: ACTOR,
    action_type: "ach_outbound",
    source_account_id: "acct_X",
    destination_counterparty_id: "cp_vendor",
    amount: "10.00",
    currency: "USD",
    status: "approved",
    policy_decision_id: null,
    evidence_ids: [],
    ...overrides,
  };
}

function makeDeps(overrides: Partial<GateDependencies> = {}): {
  deps: GateDependencies;
  audit: InMemoryAuditEmitter;
} {
  const audit = new InMemoryAuditEmitter();
  const deps: GateDependencies = {
    audit,
    resolveAgent: async () => ACTIVE_AGENT,
    resolveAccount: async () => USDC_ACCOUNT,
    resolveCounterparty: async () => VENDOR_CP,
    evaluatePolicy: async (): Promise<GatePolicyDecision> => ({
      id: "pd_OBL",
      outcome: "allow",
      matched_rule_id: "ok",
      required_approvers: [],
      ledger_snapshot_hash: "0xdead",
      trace: [],
      ach_autonomous_max_amount: { currency: "USD", value: "100.00" },
    }),
    resolveApprovals: async (): Promise<GateApprovalState> => ({ signedRoles: [] }),
    ...overrides,
  };
  return { deps, audit };
}

const ctx = { tenantId: TENANT, actor: ACTOR };
const principal: GatePrincipal = { id: ACTOR, type: "agent", scopes: ["payment_intent:execute"] };

function run(deps: GateDependencies, intent: GatePaymentIntent) {
  return runPreExecutionGate(deps, { ctx, principal, intent });
}

describe("§6 -- check 6.7: obligation_direction_matches_flow (batch 10 H-1)", () => {
  it("HARD-fails when the linked obligation is a receivable (the AR-drain bug)", async () => {
    // Wire the loader, link an obligation, return "receivable". The gate must
    // refuse: an outflow payment-intent cannot settle an obligation we are OWED.
    const { deps } = makeDeps({ resolveObligationDirection: async () => "receivable" });
    const result = await run(deps, baseIntent({ obligation_id: "obl_AR" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failedCheck.index).toBe(6.7);
      expect(result.failedCheck.name).toBe("obligation_direction_matches_flow");
      expect(result.failedCheck.detail).toMatchObject({
        obligation_id: "obl_AR",
        direction: "receivable",
      });
      // Short-circuits BEFORE amount (7) — the receivable rejection happens
      // upstream of any quantity-based check.
      expect(result.checks.some((c) => c.index === 7)).toBe(false);
    }
  });

  it("passes when the linked obligation is a payable (the canonical AP case)", async () => {
    const { deps } = makeDeps({ resolveObligationDirection: async () => "payable" });
    const result = await run(deps, baseIntent({ obligation_id: "obl_AP" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const row = result.checks.find((c) => c.name === "obligation_direction_matches_flow");
      expect(row?.passed).toBe(true);
      expect(row?.index).toBe(6.7);
      expect(row?.detail).toMatchObject({ direction: "payable" });
    }
  });

  it("passes when direction is NULL (older row before the H-1 backfill)", async () => {
    // Backfill could not infer a direction (non-vendor/non-customer
    // counterparty, e.g. a partner). The gate must not block valid older
    // payments; it stays silent rather than guessing.
    const { deps } = makeDeps({ resolveObligationDirection: async () => null });
    const result = await run(deps, baseIntent({ obligation_id: "obl_OLD" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const row = result.checks.find((c) => c.name === "obligation_direction_matches_flow");
      expect(row?.passed).toBe(true);
      expect(row?.detail).toMatchObject({ direction: null });
    }
  });

  it("adds no row when the loader is unwired (canonical path preserved)", async () => {
    // No resolveObligationDirection on deps. Even with an obligation_id, the
    // check must not appear in the trace. Preserves canonical-13 happy path
    // for callers that have not wired the loader.
    const { deps } = makeDeps();
    const result = await run(deps, baseIntent({ obligation_id: "obl_AP" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.checks.some((c) => c.name === "obligation_direction_matches_flow")).toBe(false);
    }
  });

  it("adds no row when the intent has no linked obligation", async () => {
    // Loader is wired, but the intent doesn't reference an obligation. The
    // check has nothing to check and stays absent (matches the dormant
    // semantics of every other 6.X sub-check).
    const { deps } = makeDeps({ resolveObligationDirection: async () => "receivable" });
    const result = await run(deps, baseIntent()); // no obligation_id
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.checks.some((c) => c.name === "obligation_direction_matches_flow")).toBe(false);
    }
  });

  it("adds no row when obligation_id is explicitly null", async () => {
    // Defensive: GatePaymentIntent.obligation_id is nullable; null must be
    // treated the same as undefined.
    const { deps } = makeDeps({ resolveObligationDirection: async () => "receivable" });
    const result = await run(deps, baseIntent({ obligation_id: null }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.checks.some((c) => c.name === "obligation_direction_matches_flow")).toBe(false);
    }
  });
});
