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

function defaultIntent(overrides: Partial<GatePaymentIntent> = {}): GatePaymentIntent {
  return {
    id: "pi_TEST",
    owner_id: TENANT,
    created_by_agent_id: ACTOR,
    action_type: "ach_outbound",
    source_account_id: "acct_X",
    destination_counterparty_id: "cp_AWS",
    amount: "50.00",
    currency: "USD",
    status: "approved",
    policy_decision_id: null,
    evidence_ids: [],
    ...overrides,
  };
}

function defaultPrincipal(overrides: Partial<GatePrincipal> = {}): GatePrincipal {
  return {
    id: ACTOR,
    type: "agent",
    scopes: ["payment_intent:execute"],
    ...overrides,
  };
}

const ACTIVE_AGENT: GateAgent = {
  id: ACTOR,
  state: "active",
  scope: { canExecutePayments: true },
};

const ACTIVE_ACCOUNT: GateAccount = {
  id: "acct_X",
  status: "active",
  currency: "USD",
  available_balance: "1000.00",
};

const TRUSTED_CP: GateCounterparty = {
  id: "cp_AWS",
  type: "vendor",
  risk_level: "low",
  verified_status: "document_verified",
};

function makeDecision(overrides: Partial<GatePolicyDecision> = {}): GatePolicyDecision {
  return {
    id: "pd_TEST",
    outcome: "allow",
    matched_rule_id: "small-payments-ok",
    required_approvers: [],
    ledger_snapshot_hash: "0xdeadbeef",
    trace: [],
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
    resolveAccount: async () => ACTIVE_ACCOUNT,
    resolveCounterparty: async () => TRUSTED_CP,
    evaluatePolicy: async () => makeDecision(),
    resolveApprovals: async (): Promise<GateApprovalState> => ({ signedRoles: [] }),
    ...overrides,
  };
  return { deps, audit };
}

const ctx = { tenantId: TENANT, actor: ACTOR };

describe("§6 pre-execution gate — happy path", () => {
  it("passes all 13 checks, creates PolicyDecision, emits audit-before", async () => {
    const { deps, audit } = makeDeps();
    const result = await runPreExecutionGate(deps, {
      ctx,
      principal: defaultPrincipal(),
      intent: defaultIntent(),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.policyDecisionId).toBe("pd_TEST");
      expect(result.checks).toHaveLength(13);
      expect(result.checks.every((c) => c.passed)).toBe(true);
      expect(result.checks.map((c) => c.index)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
      ]);
    }
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]!.action).toBe("payment_intent.execute.before");
    expect(audit.events[0]!.outputs.gate_passed).toBe(true);
  });
});

describe("§6 — check 1: agent identity", () => {
  it("fails when principal_type is not agent", async () => {
    const { deps } = makeDeps();
    const result = await runPreExecutionGate(deps, {
      ctx,
      principal: defaultPrincipal({ type: "user" }),
      intent: defaultIntent(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failedCheck.index).toBe(1);
  });

  it("fails when intent created_by_agent_id ≠ principal id", async () => {
    const { deps } = makeDeps();
    const result = await runPreExecutionGate(deps, {
      ctx,
      principal: defaultPrincipal({ id: "agent_other" }),
      intent: defaultIntent({ created_by_agent_id: "agent_payment01" }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failedCheck.index).toBe(1);
  });

  it("fails when agent is not active", async () => {
    const { deps } = makeDeps({
      resolveAgent: async () => ({ ...ACTIVE_AGENT, state: "revoked" }),
    });
    const result = await runPreExecutionGate(deps, {
      ctx,
      principal: defaultPrincipal(),
      intent: defaultIntent(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failedCheck.index).toBe(1);
  });
});

describe("§6 — check 2: agent authorized", () => {
  it("fails when scope is missing on both principal and agent", async () => {
    const { deps } = makeDeps({
      resolveAgent: async () => ({ ...ACTIVE_AGENT, scope: { canExecutePayments: false } }),
    });
    const result = await runPreExecutionGate(deps, {
      ctx,
      principal: defaultPrincipal({ scopes: ["wiki:read"] }),
      intent: defaultIntent(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failedCheck.index).toBe(2);
  });
});

describe("§6 — check 3: action allowed", () => {
  it("fails when policy returns reject", async () => {
    const { deps } = makeDeps({
      evaluatePolicy: async () => makeDecision({ outcome: "reject" }),
    });
    const result = await runPreExecutionGate(deps, {
      ctx,
      principal: defaultPrincipal(),
      intent: defaultIntent(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failedCheck.index).toBe(3);
  });

  it("fails when no rule matched", async () => {
    const { deps } = makeDeps({
      evaluatePolicy: async () => makeDecision({ outcome: "allow", matched_rule_id: null }),
    });
    const result = await runPreExecutionGate(deps, {
      ctx,
      principal: defaultPrincipal(),
      intent: defaultIntent(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failedCheck.index).toBe(3);
  });
});

describe("§6 — check 4: source account allowed", () => {
  it("fails when account is missing", async () => {
    const { deps } = makeDeps({ resolveAccount: async () => null });
    const result = await runPreExecutionGate(deps, {
      ctx,
      principal: defaultPrincipal(),
      intent: defaultIntent(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failedCheck.index).toBe(4);
  });
  it("fails when account is closed", async () => {
    const { deps } = makeDeps({
      resolveAccount: async () => ({ ...ACTIVE_ACCOUNT, status: "closed" }),
    });
    const result = await runPreExecutionGate(deps, {
      ctx,
      principal: defaultPrincipal(),
      intent: defaultIntent(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failedCheck.index).toBe(4);
  });
});

describe("§6 — check 5: counterparty allowed (sanctions)", () => {
  it("fails when counterparty is sanctioned", async () => {
    const { deps } = makeDeps({
      resolveCounterparty: async () => ({ ...TRUSTED_CP, risk_level: "sanctioned" }),
    });
    const result = await runPreExecutionGate(deps, {
      ctx,
      principal: defaultPrincipal(),
      intent: defaultIntent(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failedCheck.index).toBe(5);
  });
});

describe("§6 — check 6: counterparty verified above threshold", () => {
  it("fails when amount > threshold and counterparty unverified", async () => {
    const { deps } = makeDeps({
      resolveCounterparty: async () => ({ ...TRUSTED_CP, verified_status: "unverified" }),
      evaluatePolicy: async () =>
        makeDecision({
          counterparty_verification_threshold: { currency: "USD", value: "10.00" },
        }),
    });
    const result = await runPreExecutionGate(deps, {
      ctx,
      principal: defaultPrincipal(),
      intent: defaultIntent({ amount: "50.00" }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failedCheck.index).toBe(6);
  });

  it("passes when amount > threshold and counterparty document_verified", async () => {
    const { deps } = makeDeps({
      evaluatePolicy: async () =>
        makeDecision({
          counterparty_verification_threshold: { currency: "USD", value: "10.00" },
        }),
    });
    const result = await runPreExecutionGate(deps, {
      ctx,
      principal: defaultPrincipal(),
      intent: defaultIntent({ amount: "50.00" }),
    });
    expect(result.ok).toBe(true);
  });
});

describe("§6 — check 7: amount within limit", () => {
  it("fails when amount > policy upper bound", async () => {
    const { deps } = makeDeps({
      evaluatePolicy: async () =>
        makeDecision({ amount_upper_bound: { currency: "USD", value: "10.00" } }),
    });
    const result = await runPreExecutionGate(deps, {
      ctx,
      principal: defaultPrincipal(),
      intent: defaultIntent({ amount: "50.00" }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failedCheck.index).toBe(7);
  });

  it("fails on currency mismatch with the upper bound", async () => {
    const { deps } = makeDeps({
      evaluatePolicy: async () =>
        makeDecision({ amount_upper_bound: { currency: "EUR", value: "1000.00" } }),
    });
    const result = await runPreExecutionGate(deps, {
      ctx,
      principal: defaultPrincipal(),
      intent: defaultIntent({ currency: "USD" }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failedCheck.index).toBe(7);
  });
});

describe("§6 — check 8: available balance sufficient", () => {
  it("fails when amount > available_balance", async () => {
    const { deps } = makeDeps({
      resolveAccount: async () => ({ ...ACTIVE_ACCOUNT, available_balance: "10.00" }),
    });
    const result = await runPreExecutionGate(deps, {
      ctx,
      principal: defaultPrincipal(),
      intent: defaultIntent({ amount: "50.00" }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failedCheck.index).toBe(8);
  });
  it("passes when balance is null (no balance check)", async () => {
    const { deps } = makeDeps({
      resolveAccount: async () => ({ ...ACTIVE_ACCOUNT, available_balance: null }),
    });
    const result = await runPreExecutionGate(deps, {
      ctx,
      principal: defaultPrincipal(),
      intent: defaultIntent(),
    });
    expect(result.ok).toBe(true);
  });
});

describe("§6 — check 9: required evidence present", () => {
  it("fails when policy requires evidence and intent has none", async () => {
    const { deps } = makeDeps({
      evaluatePolicy: async () => makeDecision({ required_evidence_kinds: ["invoice"] }),
    });
    const result = await runPreExecutionGate(deps, {
      ctx,
      principal: defaultPrincipal(),
      intent: defaultIntent({ evidence_ids: [] }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failedCheck.index).toBe(9);
  });
  it("passes when intent supplies evidence", async () => {
    const { deps } = makeDeps({
      evaluatePolicy: async () => makeDecision({ required_evidence_kinds: ["invoice"] }),
    });
    const result = await runPreExecutionGate(deps, {
      ctx,
      principal: defaultPrincipal(),
      intent: defaultIntent({ evidence_ids: ["doc_123"] }),
    });
    expect(result.ok).toBe(true);
  });
});

describe("§6 — check 11: approval granted when required", () => {
  it("fails when outcome=confirm but quorum not signed", async () => {
    const { deps } = makeDeps({
      evaluatePolicy: async () =>
        makeDecision({ outcome: "confirm", required_approvers: ["cfo", "ceo"] }),
      resolveApprovals: async () => ({ signedRoles: ["cfo"] }),
    });
    const result = await runPreExecutionGate(deps, {
      ctx,
      principal: defaultPrincipal(),
      intent: defaultIntent(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failedCheck.index).toBe(11);
      expect(result.failedCheck.detail!.missing).toEqual(["ceo"]);
    }
  });
  it("passes when outcome=confirm and full quorum signed", async () => {
    const { deps } = makeDeps({
      evaluatePolicy: async () =>
        makeDecision({ outcome: "confirm", required_approvers: ["cfo", "ceo"] }),
      resolveApprovals: async () => ({ signedRoles: ["cfo", "ceo"] }),
    });
    const result = await runPreExecutionGate(deps, {
      ctx,
      principal: defaultPrincipal(),
      intent: defaultIntent(),
    });
    expect(result.ok).toBe(true);
  });
});

describe("§6 — invariant: gate emits exactly one audit-before event", () => {
  it("happy path emits exactly one event", async () => {
    const { deps, audit } = makeDeps();
    await runPreExecutionGate(deps, {
      ctx,
      principal: defaultPrincipal(),
      intent: defaultIntent(),
    });
    expect(audit.events).toHaveLength(1);
  });
  it("failure paths emit zero events (caller emits the audit-after)", async () => {
    const { deps, audit } = makeDeps({ resolveAccount: async () => null });
    const result = await runPreExecutionGate(deps, {
      ctx,
      principal: defaultPrincipal(),
      intent: defaultIntent(),
    });
    expect(result.ok).toBe(false);
    expect(audit.events).toHaveLength(0);
  });
});
