/**
 * §6 gate — check 6.6: escrow-state binding (RFC 0001 §6.2 / §7.6, Phase 3D).
 *
 * For a conditional (escrow) settlement, the gate binds the on-chain escrow lock
 * to the intent before a release is gated: still Locked, same amount, same payee
 * (== counterparty on-chain address), same job-terms commitment. Follows the
 * dormant-until-wired idiom — no check row when the intent carries no `escrow`
 * context or the `resolveEscrowState` loader is unwired (canonical path intact).
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
import type { ResolvedEscrowState } from "./escrow-binding.js";

const TENANT = "tnt_test";
const ACTOR = "agent_payment01";
const PAYEE = "0x" + "ab".repeat(20);
const ESCROW_ID = "0x" + "11".repeat(32);
const TERMS = "0x" + "22".repeat(32);

const ACTIVE_AGENT: GateAgent = { id: ACTOR, state: "active", scope: { canExecutePayments: true } };
const USDC_ACCOUNT: GateAccount = {
  id: "acct_X",
  status: "active",
  currency: "USDC",
  available_balance: "1000.00",
};
const AGENT_CP: GateCounterparty = {
  id: "cp_agent",
  type: "agent",
  risk_level: "low",
  verified_status: "document_verified",
  agent_id: "agent_01J0000000000000000000000A",
  onchain_address: PAYEE,
};

/** A settlement intent WITHOUT an escrow context (escrow checks stay dormant). */
function baseIntent(overrides: Partial<GatePaymentIntent> = {}): GatePaymentIntent {
  return {
    id: "pi_ESC",
    owner_id: TENANT,
    created_by_agent_id: ACTOR,
    action_type: "escrow_release",
    source_account_id: "acct_X",
    destination_counterparty_id: "cp_agent",
    amount: "10.00",
    currency: "USDC",
    status: "approved",
    policy_decision_id: null,
    evidence_ids: [],
    ...overrides,
  };
}

/** An escrow_release intent carrying the on-chain escrow context (activates 6.6). */
function escrowIntent(overrides: Partial<GatePaymentIntent> = {}): GatePaymentIntent {
  return { ...baseIntent(), escrow: { escrowId: ESCROW_ID, jobTermsHash: TERMS }, ...overrides };
}

function lockedEscrow(overrides: Partial<ResolvedEscrowState> = {}): ResolvedEscrowState {
  return {
    state: "Locked",
    payer: "0x" + "cd".repeat(20),
    payee: PAYEE,
    token: "0x" + "ef".repeat(20),
    amount: "10.00",
    jobTermsHash: TERMS,
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
    resolveCounterparty: async () => AGENT_CP,
    evaluatePolicy: async (): Promise<GatePolicyDecision> => ({
      id: "pd_ESC",
      outcome: "allow",
      matched_rule_id: "ok",
      required_approvers: [],
      ledger_snapshot_hash: "0xdead",
      trace: [],
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

describe("§6 — check 6.6: escrow-state binding (RFC 0001 §7.6)", () => {
  it("passes when the on-chain lock matches the intent (Locked/amount/payee/terms)", async () => {
    const { deps } = makeDeps({ resolveEscrowState: async () => lockedEscrow() });
    const result = await run(deps, escrowIntent());
    expect(result.ok).toBe(true);
    if (result.ok) {
      const row = result.checks.find((c) => c.name === "escrow_state_bound");
      expect(row?.passed).toBe(true);
      expect(row?.index).toBe(6.6);
    }
  });

  it("matches the payee address case-insensitively", async () => {
    const { deps } = makeDeps({
      resolveEscrowState: async () => lockedEscrow({ payee: PAYEE.toUpperCase() }),
    });
    const result = await run(deps, escrowIntent());
    expect(result.ok).toBe(true);
  });

  it.each([
    ["escrow not Locked", lockedEscrow({ state: "Released" })],
    ["amount mismatch", lockedEscrow({ amount: "9.99" })],
    ["job-terms mismatch", lockedEscrow({ jobTermsHash: "0x" + "33".repeat(32) })],
    ["payee mismatch", lockedEscrow({ payee: "0x" + "99".repeat(20) })],
  ])("HARD-fails at 6.6 on %s", async (_label, onchain) => {
    const { deps } = makeDeps({ resolveEscrowState: async () => onchain });
    const result = await run(deps, escrowIntent());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failedCheck.index).toBe(6.6);
      expect(result.failedCheck.name).toBe("escrow_state_bound");
      expect(Array.isArray(result.failedCheck.detail!.failures)).toBe(true);
      // short-circuits before amount (7) runs.
      expect(result.checks.some((c) => c.index === 7)).toBe(false);
    }
  });

  it("HARD-fails when the on-chain escrow is unknown (loader returns null)", async () => {
    const { deps } = makeDeps({ resolveEscrowState: async () => null });
    const result = await run(deps, escrowIntent());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failedCheck.index).toBe(6.6);
  });

  it("adds no row when the loader is unwired (canonical path preserved)", async () => {
    const { deps } = makeDeps(); // no resolveEscrowState
    const result = await run(deps, escrowIntent());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.checks.some((c) => c.name === "escrow_state_bound")).toBe(false);
    }
  });

  it("adds no row for a non-escrow intent even when the loader is wired", async () => {
    const { deps } = makeDeps({ resolveEscrowState: async () => lockedEscrow() });
    const result = await run(deps, baseIntent({ action_type: "ach_outbound" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.checks.some((c) => c.name === "escrow_state_bound")).toBe(false);
    }
  });
});
