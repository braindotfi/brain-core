import { describe, expect, it } from "vitest";
import fc from "fast-check";
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
      // The 13 §6 checks plus the 7.5 ledger-state binding and 9.5 evidence check.
      expect(result.checks).toHaveLength(15);
      expect(result.checks.every((c) => c.passed)).toBe(true);
      expect(result.checks.map((c) => c.index)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 7.5, 8, 9, 9.5, 10, 11, 12, 13,
      ]);
      // check 7.5 binds a verifiable ledger-state hash onto the result.
      expect(result.ledgerStateHash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]!.action).toBe("payment_intent.execute.before");
    expect(audit.events[0]!.outputs.gate_passed).toBe(true);
    if (result.ok) {
      expect(audit.events[0]!.inputs.ledger_state_hash).toBe(result.ledgerStateHash);
    }
  });
});

describe("§6 — check 9.5: evidence semantic validation (H-21)", () => {
  function invoiceEv(amountDue: string) {
    return [
      {
        id: "prs_inv",
        kind: "invoice",
        sourceArtifactId: "raw_1",
        capturedAt: new Date(),
        trustLevel: "high" as const,
        extracted: {
          invoice_number: "INV-1",
          counterparty_id: "cp_AWS",
          amount_due: amountDue,
          currency: "USD",
        },
      },
    ];
  }
  const payInvoiceIntent = () =>
    defaultIntent({ action_type: "pay_invoice", invoice_id: "INV-1", amount: "50.00" });

  it("passes 9.5 when the loaded evidence supports the action", async () => {
    const { deps } = makeDeps({ resolveEvidence: async () => invoiceEv("50.00") });
    const result = await runPreExecutionGate(deps, {
      ctx,
      principal: defaultPrincipal(),
      intent: payInvoiceIntent(),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.checks.some((c) => c.name === "evidence_supports_action" && c.passed)).toBe(
        true,
      );
    }
  });

  it("fails 9.5 and short-circuits 10+ when the invoice amount doesn't match", async () => {
    const { deps } = makeDeps({ resolveEvidence: async () => invoiceEv("500.00") });
    const result = await runPreExecutionGate(deps, {
      ctx,
      principal: defaultPrincipal(),
      intent: payInvoiceIntent(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failedCheck.index).toBe(9.5);
      expect(result.failedCheck.name).toBe("evidence_supports_action");
      // 10/11/12/13 never ran.
      expect(result.checks.some((c) => c.index === 10)).toBe(false);
    }
  });
});

describe("§6 — property: amount (check 7) and balance (check 8) are monotonic (Standards §8)", () => {
  it("gate passes iff amount ≤ policy limit AND balance ≥ amount, else fails at the first offending check", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 100_000_00 }),
        fc.integer({ min: 0, max: 100_000_00 }),
        fc.integer({ min: 0, max: 100_000_00 }),
        async (amountCents, limitCents, balanceCents) => {
          const amount = (amountCents / 100).toFixed(2);
          const limit = (limitCents / 100).toFixed(2);
          const balance = (balanceCents / 100).toFixed(2);
          const { deps } = makeDeps({
            resolveAccount: async () => ({ ...ACTIVE_ACCOUNT, available_balance: balance }),
            evaluatePolicy: async () =>
              makeDecision({ amount_upper_bound: { currency: "USD", value: limit } }),
          });
          const result = await runPreExecutionGate(deps, {
            ctx,
            principal: defaultPrincipal(),
            intent: defaultIntent({ amount }),
          });
          const expectOk = amountCents <= limitCents && balanceCents >= amountCents;
          expect(result.ok).toBe(expectOk);
          if (!result.ok) {
            // Check 7 (amount) short-circuits before check 8 (balance).
            expect(result.failedCheck.index).toBe(amountCents > limitCents ? 7 : 8);
          }
        },
      ),
      { numRuns: 250 },
    );
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

describe("§6 — check 8: balance net of active reservations (1b.1)", () => {
  it("fails when amount + active reservations exceed available balance", async () => {
    // available 1000, reserved 800, requesting 300 → 800+300 > 1000 → fail
    const { deps } = makeDeps({ sumActiveReservations: async () => "800.00" });
    const result = await runPreExecutionGate(deps, {
      ctx,
      principal: defaultPrincipal(),
      intent: defaultIntent({ amount: "300.00" }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failedCheck.index).toBe(8);
      expect(result.failedCheck.detail!.reserved).toBe("800.00");
    }
  });

  it("passes when amount + active reservations fit within available balance", async () => {
    const { deps } = makeDeps({ sumActiveReservations: async () => "500.00" });
    const result = await runPreExecutionGate(deps, {
      ctx,
      principal: defaultPrincipal(),
      intent: defaultIntent({ amount: "300.00" }),
    });
    expect(result.ok).toBe(true);
  });

  it("subtracts reservations in dry-run too (read-only)", async () => {
    const { deps, audit } = makeDeps({ sumActiveReservations: async () => "800.00" });
    const result = await runPreExecutionGate(deps, {
      ctx,
      principal: defaultPrincipal(),
      intent: defaultIntent({ amount: "300.00" }),
      dryRun: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failedCheck.index).toBe(8);
    expect(audit.events).toHaveLength(0);
  });
});

describe("§6 — dry-run mode (1a.2): same checks, no side effects", () => {
  it("passes all 13 checks but writes no policy_decisions row and emits no audit", async () => {
    const { deps, audit } = makeDeps();
    const result = await runPreExecutionGate(deps, {
      ctx,
      principal: defaultPrincipal(),
      intent: defaultIntent(),
      dryRun: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.dryRun).toBe(true);
      expect(result.outcome).toBe("allow");
      expect(result.policyDecisionId).toBe(""); // no row persisted
      expect(result.auditBeforeEventId).toBe(""); // no audit emitted
      expect(result.checks).toHaveLength(15);
    }
    expect(audit.events).toHaveLength(0); // INV-6 side effect suppressed in dry-run
  });

  it("returns the same reject outcome as a live call (one evaluator)", async () => {
    const { deps, audit } = makeDeps({
      evaluatePolicy: async () => makeDecision({ outcome: "reject" }),
    });
    const result = await runPreExecutionGate(deps, {
      ctx,
      principal: defaultPrincipal(),
      intent: defaultIntent(),
      dryRun: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.dryRun).toBe(true);
      expect(result.failedCheck.index).toBe(3);
    }
    expect(audit.events).toHaveLength(0);
  });

  it("caches the trace when a traceCache is provided", async () => {
    const writes: Array<{ key: string; ttl: number }> = [];
    const { deps } = makeDeps({
      evaluatePolicy: async () => makeDecision({ trace: [{ rule: "ok" }] }),
      traceCache: {
        set: async (key, _trace, ttlSeconds) => {
          writes.push({ key, ttl: ttlSeconds });
        },
      },
    });
    await runPreExecutionGate(deps, {
      ctx,
      principal: defaultPrincipal(),
      intent: defaultIntent(),
      dryRun: true,
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]!.key).toMatch(/^gate:dryrun:[0-9a-f]{64}$/);
    expect(writes[0]!.ttl).toBe(60);
  });
});

describe("§6 — check 1.5: agent behavior pinned (2.3)", () => {
  it("passes when the runtime behaviorHash matches the registered one", async () => {
    const { deps } = makeDeps({
      resolveAgent: async () => ({ ...ACTIVE_AGENT, behaviorHash: "0xabc" }),
    });
    const result = await runPreExecutionGate(deps, {
      ctx,
      principal: defaultPrincipal(),
      intent: defaultIntent(),
      runtimeBehaviorHash: "0xabc",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.checks.some((c) => c.name === "agent_behavior_pinned")).toBe(true);
    }
  });

  it("rejects when the runtime behaviorHash differs (hard stop)", async () => {
    const { deps } = makeDeps({
      resolveAgent: async () => ({ ...ACTIVE_AGENT, behaviorHash: "0xabc" }),
    });
    const result = await runPreExecutionGate(deps, {
      ctx,
      principal: defaultPrincipal(),
      intent: defaultIntent(),
      runtimeBehaviorHash: "0xdef",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failedCheck.name).toBe("agent_behavior_pinned");
  });

  it("skips the check (canonical 13) when no runtime hash is supplied", async () => {
    const { deps } = makeDeps({
      resolveAgent: async () => ({ ...ACTIVE_AGENT, behaviorHash: "0xabc" }),
    });
    const result = await runPreExecutionGate(deps, {
      ctx,
      principal: defaultPrincipal(),
      intent: defaultIntent(),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.checks).toHaveLength(15);
      expect(result.checks.some((c) => c.name === "agent_behavior_pinned")).toBe(false);
    }
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
