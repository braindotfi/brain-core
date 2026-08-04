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
    ach_autonomous_max_amount: { currency: "USD", value: "1000000.00" },
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
      // The 13 §6 checks plus 7.5 ledger-state, 9.5 evidence, 11.5 duplicate.
      expect(result.checks).toHaveLength(16);
      expect(result.checks.every((c) => c.passed)).toBe(true);
      expect(result.checks.map((c) => c.index)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 7.5, 8, 9, 9.5, 10, 11, 11.5, 12, 13,
      ]);
      // check 7.5 binds a verifiable ledger-state hash onto the result.
      expect(result.ledgerStateHash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]!.action).toBe("payment_intent.execute.before");
    expect(audit.events[0]!.outputs.gate_passed).toBe(true);
    // H-07: the before-event persists the §6 check trace so the Proof API can
    // reproduce it faithfully from history.
    const persistedChecks = audit.events[0]!.outputs.gate_checks as Array<{ index: number }>;
    expect(Array.isArray(persistedChecks)).toBe(true);
    expect(persistedChecks.map((c) => c.index)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 7.5, 8, 9, 9.5, 10, 11, 11.5, 12,
    ]);
    if (result.ok) {
      expect(audit.events[0]!.inputs.ledger_state_hash).toBe(result.ledgerStateHash);
    }
  });
});

describe("§6 — check 3: policy outcome must be canonical", () => {
  it("fails closed when a policy decision returns a non-canonical outcome", async () => {
    const { deps } = makeDeps({
      evaluatePolicy: async () => makeDecision({ outcome: "review_later" as never }),
    });
    const result = await runPreExecutionGate(deps, {
      ctx,
      principal: defaultPrincipal(),
      intent: defaultIntent(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failedCheck.index).toBe(3);
      expect(result.failedCheck.name).toBe("action_allowed");
      expect(result.failedCheck.detail!.reason).toBe("non_canonical_policy_outcome");
      expect(result.failedCheck.detail!.outcome).toBe("review_later");
    }
  });
});

describe("§6 gate metrics", () => {
  const throwingMetrics = {
    increment: () => {
      throw new Error("metrics down");
    },
    duration: () => {
      throw new Error("metrics down");
    },
    gauge: () => {
      throw new Error("metrics down");
    },
    histogram: () => {
      throw new Error("metrics down");
    },
  };

  it("does not fail a passing gate when metrics throw", async () => {
    const { deps } = makeDeps({ metrics: throwingMetrics as never });
    const result = await runPreExecutionGate(deps, {
      ctx,
      principal: defaultPrincipal(),
      intent: defaultIntent(),
    });
    expect(result.ok).toBe(true);
  });

  it("preserves the original gate failure when metrics throw", async () => {
    const { deps } = makeDeps({
      metrics: throwingMetrics as never,
      resolveAccount: async () => null,
    });
    const result = await runPreExecutionGate(deps, {
      ctx,
      principal: defaultPrincipal(),
      intent: defaultIntent(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failedCheck.name).toBe("source_account_allowed");
    }
  });
});

describe("§6 — check 9.5: evidence semantic validation (H-21)", () => {
  // Real action_type + real evidence-kind vocabulary: a stored PaymentIntent's
  // action_type is a rail (ach_outbound/wire/...), never "pay_invoice", and
  // the resolveEvidence loader's extracted.id is the ledger_invoices PK, not
  // the human-readable invoice_number -- see shared/src/gate/evidence-validator.ts.
  function invoiceEv(amountDue: string) {
    return [
      {
        id: "prs_inv",
        kind: "invoice",
        sourceArtifactId: "raw_1",
        capturedAt: new Date(),
        trustLevel: "high" as const,
        extracted: {
          id: "inv_1",
          invoice_number: "INV-1",
          counterparty_id: "cp_AWS",
          amount_due: amountDue,
          amount_paid: "0.00",
          currency: "USD",
        },
      },
    ];
  }
  const payInvoiceIntent = () =>
    defaultIntent({ action_type: "ach_outbound", invoice_id: "inv_1", amount: "50.00" });

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

  it("H-21 CRITICAL regression: a $500 invoice from a different counterparty cannot back a $50,000 payment", async () => {
    // The exact attack the module exists to stop: attach a small, unrelated
    // invoice as evidence for a large payment to a different counterparty.
    const { deps } = makeDeps({
      // Large enough balance that check 8 (available balance) does not fire
      // first and mask the check 9.5 failure this test targets.
      resolveAccount: async () => ({ ...ACTIVE_ACCOUNT, available_balance: "1000000.00" }),
      resolveEvidence: async () => [
        {
          id: "prs_inv",
          kind: "invoice",
          sourceArtifactId: "raw_1",
          capturedAt: new Date(),
          trustLevel: "high" as const,
          extracted: {
            id: "inv_1",
            invoice_number: "INV-1",
            counterparty_id: "cp_OTHER",
            amount_due: "500.00",
            amount_paid: "0.00",
            currency: "USD",
          },
        },
      ],
    });
    const result = await runPreExecutionGate(deps, {
      ctx,
      principal: defaultPrincipal(),
      intent: defaultIntent({
        action_type: "ach_outbound",
        invoice_id: "inv_1",
        amount: "50000.00",
        destination_counterparty_id: "cp_AWS",
      }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failedCheck.index).toBe(9.5);
      const failures = (result.failedCheck.detail as { failures: Array<{ rule: string }> })
        .failures;
      expect(failures.map((f) => f.rule)).toEqual(
        expect.arrayContaining(["counterparty_match", "amount_match"]),
      );
    }
  });

  it("is not_applicable for a non-money-out action type (ach_inbound)", async () => {
    const { deps } = makeDeps({
      resolveEvidence: async () => invoiceEv("999999.00"), // would fail if evaluated
    });
    const result = await runPreExecutionGate(deps, {
      ctx,
      principal: defaultPrincipal(),
      intent: defaultIntent({ action_type: "ach_inbound", invoice_id: "inv_1" }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const check = result.checks.find((c) => c.index === 9.5);
      expect(check?.passed).toBe(true);
    }
  });

  it("is not_applicable for a money-out payment with neither invoice_id nor obligation_id", async () => {
    const { deps } = makeDeps({
      resolveEvidence: async () => invoiceEv("999999.00"), // would fail if evaluated
    });
    const result = await runPreExecutionGate(deps, {
      ctx,
      principal: defaultPrincipal(),
      intent: defaultIntent({ action_type: "ach_outbound" }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const check = result.checks.find((c) => c.index === 9.5);
      expect(check?.passed).toBe(true);
    }
  });

  it("dispatches to the obligation validator when obligation_id is set (real production vocabulary)", async () => {
    const { deps } = makeDeps({
      resolveEvidence: async () => [
        {
          id: "prs_obl",
          kind: "obligation_reference",
          sourceArtifactId: "raw_obl",
          capturedAt: new Date(),
          trustLevel: "high" as const,
          extracted: { counterparty_id: "cp_AWS", amount_due: "50.00", status: "paid" },
        },
      ],
    });
    const result = await runPreExecutionGate(deps, {
      ctx,
      principal: defaultPrincipal(),
      intent: defaultIntent({ action_type: "wire", obligation_id: "obl_1", amount: "50.00" }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failedCheck.index).toBe(9.5);
      const failures = (result.failedCheck.detail as { failures: Array<{ rule: string }> })
        .failures;
      expect(failures.map((f) => f.rule)).toContain("obligation_status");
    }
  });
});

describe("§6 — check 11.5: duplicate-payment guard (H-22)", () => {
  it("passes 11.5 when the detector finds no collision", async () => {
    const { deps } = makeDeps({ detectDuplicates: async () => ({ passed: true, collisions: [] }) });
    const result = await runPreExecutionGate(deps, {
      ctx,
      principal: defaultPrincipal(),
      intent: defaultIntent(),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.checks.some((c) => c.name === "no_duplicate_payment" && c.passed)).toBe(true);
    }
  });

  it("HARD-rejects at 11.5 on a collision even when approval is present", async () => {
    const { deps } = makeDeps({
      // Require + grant approval, so the reject is purely the duplicate guard.
      evaluatePolicy: async () =>
        makeDecision({ outcome: "confirm", required_approvers: ["admin"] }),
      resolveApprovals: async () => ({ signedRoles: ["admin"] }),
      detectDuplicates: async () => ({
        passed: false,
        collisions: [
          {
            rule: "invoice_already_paid",
            detail: "INV-1 already paid",
            conflicting_payment_intent_id: "pi_OLD",
          },
        ],
      }),
    });
    const result = await runPreExecutionGate(deps, {
      ctx,
      principal: defaultPrincipal(),
      intent: defaultIntent({ invoice_id: "INV-1" }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failedCheck.index).toBe(11.5);
      expect(result.failedCheck.name).toBe("no_duplicate_payment");
      expect(result.checks.some((c) => c.index === 12)).toBe(false); // 12/13 never ran
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
        makeDecision({ outcome: "confirm", required_approvers: ["admin", "approver"] }),
      resolveApprovals: async () => ({ signedRoles: ["admin"] }),
    });
    const result = await runPreExecutionGate(deps, {
      ctx,
      principal: defaultPrincipal(),
      intent: defaultIntent(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failedCheck.index).toBe(11);
      expect(result.failedCheck.detail!.missing).toEqual(["approver"]);
    }
  });
  it("passes when outcome=confirm and full quorum signed", async () => {
    const { deps } = makeDeps({
      evaluatePolicy: async () =>
        makeDecision({ outcome: "confirm", required_approvers: ["admin", "approver"] }),
      resolveApprovals: async () => ({ signedRoles: ["admin", "approver"] }),
    });
    const result = await runPreExecutionGate(deps, {
      ctx,
      principal: defaultPrincipal(),
      intent: defaultIntent(),
    });
    expect(result.ok).toBe(true);
  });
});

// These pin the §6 gate's check 11 to the SAME generic-slot quorum semantics
// as ApprovalService.hasRequiredRoleQuorum (both now call the one shared
// implementation in @brain/shared's gate/approverRoles.ts). Before this fix,
// check 11 did a naive literal match on the string "signer", which could
// never be satisfied by a real recorded approver_role ("admin" | "approver"),
// so every "single_signer" / vm.ts-defaulted policy could never clear the
// gate no matter who approved.
describe("§6 - check 11: generic signer-slot quorum matches ApprovalService", () => {
  it('["signer"] is satisfied by a single admin signature', async () => {
    const { deps } = makeDeps({
      evaluatePolicy: async () =>
        makeDecision({ outcome: "confirm", required_approvers: ["signer"] }),
      resolveApprovals: async () => ({ signedRoles: ["admin"] }),
    });
    const result = await runPreExecutionGate(deps, {
      ctx,
      principal: defaultPrincipal(),
      intent: defaultIntent(),
    });
    expect(result.ok).toBe(true);
  });

  it('["signer","signer"] is NOT satisfied by one signature', async () => {
    const { deps } = makeDeps({
      evaluatePolicy: async () =>
        makeDecision({ outcome: "confirm", required_approvers: ["signer", "signer"] }),
      resolveApprovals: async () => ({ signedRoles: ["admin"] }),
    });
    const result = await runPreExecutionGate(deps, {
      ctx,
      principal: defaultPrincipal(),
      intent: defaultIntent(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failedCheck.index).toBe(11);
  });

  it('["admin"] is satisfied by an admin signature and not by an approver signature', async () => {
    const decision = () => makeDecision({ outcome: "confirm", required_approvers: ["admin"] });
    const admin = makeDeps({
      evaluatePolicy: async () => decision(),
      resolveApprovals: async () => ({ signedRoles: ["admin"] }),
    });
    const approver = makeDeps({
      evaluatePolicy: async () => decision(),
      resolveApprovals: async () => ({ signedRoles: ["approver"] }),
    });
    const adminResult = await runPreExecutionGate(admin.deps, {
      ctx,
      principal: defaultPrincipal(),
      intent: defaultIntent(),
    });
    const approverResult = await runPreExecutionGate(approver.deps, {
      ctx,
      principal: defaultPrincipal(),
      intent: defaultIntent(),
    });
    expect(adminResult.ok).toBe(true);
    expect(approverResult.ok).toBe(false);
  });

  it('["admin","signer"] needs the named admin role PLUS one more signed role', async () => {
    const decision = () =>
      makeDecision({ outcome: "confirm", required_approvers: ["admin", "signer"] });
    const adminOnly = makeDeps({
      evaluatePolicy: async () => decision(),
      resolveApprovals: async () => ({ signedRoles: ["admin"] }),
    });
    const adminPlusApprover = makeDeps({
      evaluatePolicy: async () => decision(),
      resolveApprovals: async () => ({ signedRoles: ["admin", "approver"] }),
    });
    const adminOnlyResult = await runPreExecutionGate(adminOnly.deps, {
      ctx,
      principal: defaultPrincipal(),
      intent: defaultIntent(),
    });
    const adminPlusApproverResult = await runPreExecutionGate(adminPlusApprover.deps, {
      ctx,
      principal: defaultPrincipal(),
      intent: defaultIntent(),
    });
    // Admin alone fills the named "admin" slot but leaves no spare role for
    // the generic "signer" slot.
    expect(adminOnlyResult.ok).toBe(false);
    // The extra "approver" signature fills the generic slot once "admin" is
    // consumed by the named requirement.
    expect(adminPlusApproverResult.ok).toBe(true);
  });
});

describe("§6 — check 11: policy-version-aware approvals (P0.4)", () => {
  it("threads the decision's policy_version into resolveApprovals", async () => {
    let seenVersion: number | undefined;
    const { deps } = makeDeps({
      evaluatePolicy: async () =>
        makeDecision({ outcome: "confirm", required_approvers: ["admin"], policy_version: 7 }),
      resolveApprovals: async (_id, v) => {
        seenVersion = v;
        return { signedRoles: ["admin"] };
      },
    });
    const result = await runPreExecutionGate(deps, {
      ctx,
      principal: defaultPrincipal(),
      intent: defaultIntent(),
    });
    expect(result.ok).toBe(true);
    expect(seenVersion).toBe(7);
  });

  it("fails check 11 when stale signatures are excluded by version", async () => {
    const { deps } = makeDeps({
      evaluatePolicy: async () =>
        makeDecision({ outcome: "confirm", required_approvers: ["admin"], policy_version: 8 }),
      // Resolver excludes the (stale) signature when asked for the active version.
      resolveApprovals: async (_id, v) => ({ signedRoles: v === 8 ? [] : ["admin"] }),
    });
    const result = await runPreExecutionGate(deps, {
      ctx,
      principal: defaultPrincipal(),
      intent: defaultIntent(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failedCheck.index).toBe(11);
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
      expect(result.checks).toHaveLength(16);
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
      expect(result.checks).toHaveLength(16);
      expect(result.checks.some((c) => c.name === "agent_behavior_pinned")).toBe(false);
    }
  });
});

describe("§6 — check 1.5: mandatory behavior-hash pinning for opt-in tenants (P0.1)", () => {
  const optIn = { resolveTenantFlags: async () => ({ requireBehaviorHash: true }) };
  const optOut = { resolveTenantFlags: async () => ({ requireBehaviorHash: false }) };

  it("(a) opt-in tenant + missing runtime hash → fails closed at 1.5", async () => {
    const { deps } = makeDeps({
      ...optIn,
      resolveAgent: async () => ({ ...ACTIVE_AGENT, behaviorHash: "0xabc" }),
    });
    const result = await runPreExecutionGate(deps, {
      ctx,
      principal: defaultPrincipal(),
      intent: defaultIntent(),
      // no runtimeBehaviorHash supplied
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failedCheck.index).toBe(1.5);
      expect(result.failedCheck.name).toBe("agent_behavior_pinned");
      expect(result.failedCheck.detail!.require_behavior_hash).toBe(true);
    }
  });

  it("(a') opt-in tenant + missing registered hash → fails closed at 1.5", async () => {
    const { deps } = makeDeps({ ...optIn }); // ACTIVE_AGENT has no behaviorHash
    const result = await runPreExecutionGate(deps, {
      ctx,
      principal: defaultPrincipal(),
      intent: defaultIntent(),
      runtimeBehaviorHash: "0xabc",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failedCheck.index).toBe(1.5);
  });

  it("(b) opt-in tenant + matching hashes → passes 1.5", async () => {
    const { deps } = makeDeps({
      ...optIn,
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
      const pinned = result.checks.find((c) => c.name === "agent_behavior_pinned");
      expect(pinned?.passed).toBe(true);
      expect(pinned?.detail?.not_applicable).toBeUndefined();
    }
  });

  it("(c) opt-in tenant + mismatched hashes → fails at 1.5", async () => {
    const { deps } = makeDeps({
      ...optIn,
      resolveAgent: async () => ({ ...ACTIVE_AGENT, behaviorHash: "0xabc" }),
    });
    const result = await runPreExecutionGate(deps, {
      ctx,
      principal: defaultPrincipal(),
      intent: defaultIntent(),
      runtimeBehaviorHash: "0xdef",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failedCheck.index).toBe(1.5);
      expect(result.failedCheck.detail!.registered).toBe("0xabc");
    }
  });

  it("(d) opt-out tenant + missing hash → skips with not_applicable, gate passes", async () => {
    const { deps } = makeDeps({
      ...optOut,
      resolveAgent: async () => ({ ...ACTIVE_AGENT, behaviorHash: "0xabc" }),
    });
    const result = await runPreExecutionGate(deps, {
      ctx,
      principal: defaultPrincipal(),
      intent: defaultIntent(),
      // no runtimeBehaviorHash
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const pinned = result.checks.find((c) => c.name === "agent_behavior_pinned");
      expect(pinned?.passed).toBe(true);
      expect(pinned?.detail?.not_applicable).toBe(true);
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
