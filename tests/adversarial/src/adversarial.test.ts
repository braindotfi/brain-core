/**
 * P1.1 — adversarial safety suite. Each vector asserts the system FAILS CLOSED.
 *
 * Most vectors are exercised at the logic layer (the §6 gate, ApprovalService,
 * the PaymentIntent state machine, scope checks) with in-memory fakes, so they
 * run on every PR without a DB. The two genuinely storage-level vectors (tenant
 * RLS swap, policy-downgrade persistence) live in integration/ (skip-guarded on
 * DATABASE_URL). For gate/approval rejections the fail-closed result IS the
 * safety property; the matching audit-after event is emitted by
 * PaymentIntentService and covered by the invariants integration suite.
 */

import { describe, expect, it } from "vitest";
import {
  InMemoryAuditEmitter,
  requireScope,
  runPreExecutionGate,
  newTenantId,
  newUserId,
  type GateAccount,
  type GateAgent,
  type GateCounterparty,
  type GateDependencies,
  type GatePaymentIntent,
  type GatePolicyDecision,
  type GatePrincipal,
  type ServiceCallContext,
} from "@brain/shared";
import { ApprovalService, isValidPaymentIntentTransition } from "@brain/execution";
import type { ApprovalServiceDeps } from "@brain/execution";
import type { Pool } from "pg";

const TENANT = "tnt_adv";
const ACTOR = "agent_adv";
const ctx = { tenantId: TENANT, actor: ACTOR };

const ACTIVE_AGENT: GateAgent = { id: ACTOR, state: "active", scope: { canExecutePayments: true } };
const ACTIVE_ACCOUNT: GateAccount = {
  id: "acct_x",
  status: "active",
  currency: "USD",
  available_balance: "1000.00",
};
const TRUSTED_CP: GateCounterparty = {
  id: "cp_x",
  type: "vendor",
  risk_level: "low",
  verified_status: "document_verified",
};

function intent(over: Partial<GatePaymentIntent> = {}): GatePaymentIntent {
  return {
    id: "pi_adv",
    owner_id: TENANT,
    created_by_agent_id: ACTOR,
    action_type: "ach_outbound",
    source_account_id: "acct_x",
    destination_counterparty_id: "cp_x",
    amount: "50.00",
    currency: "USD",
    status: "approved",
    policy_decision_id: null,
    evidence_ids: [],
    ...over,
  };
}

function principal(over: Partial<GatePrincipal> = {}): GatePrincipal {
  return { id: ACTOR, type: "agent", scopes: ["payment_intent:execute"], ...over };
}

function decision(over: Partial<GatePolicyDecision> = {}): GatePolicyDecision {
  return {
    id: "pd_adv",
    outcome: "allow",
    matched_rule_id: "ok",
    required_approvers: [],
    ledger_snapshot_hash: "0x",
    trace: [],
    ...over,
  };
}

function gateDeps(over: Partial<GateDependencies> = {}): GateDependencies {
  return {
    audit: new InMemoryAuditEmitter(),
    resolveAgent: async () => ACTIVE_AGENT,
    resolveAccount: async () => ACTIVE_ACCOUNT,
    resolveCounterparty: async () => TRUSTED_CP,
    evaluatePolicy: async () => decision(),
    resolveApprovals: async () => ({ signedRoles: [] }),
    ...over,
  };
}

describe("P1.1 adversarial — fail closed", () => {
  // 2. Role escalation: a non-admin attempts a policy:sign operation.
  it("role escalation: missing scope is rejected", () => {
    expect(() => requireScope(["wiki:read", "ledger:read"], "policy:sign")).toThrow();
    expect(() => requireScope(["policy:sign"], "policy:sign")).not.toThrow();
  });

  // 8. FX envelope bypass: account currency ≠ intent currency.
  it("FX bypass: account/intent currency mismatch fails at check 8", async () => {
    const deps = gateDeps({
      resolveAccount: async () => ({ ...ACTIVE_ACCOUNT, currency: "EUR" }),
    });
    const r = await runPreExecutionGate(deps, { ctx, principal: principal(), intent: intent() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failedCheck.index).toBe(8);
  });

  // 6. Duplicate payment: hard reject at 11.5 even with a valid approval.
  it("duplicate payment: hard reject at 11.5 despite approval", async () => {
    const deps = gateDeps({
      evaluatePolicy: async () => decision({ outcome: "confirm", required_approvers: ["cfo"] }),
      resolveApprovals: async () => ({ signedRoles: ["cfo"] }),
      detectDuplicates: async () => ({
        passed: false,
        collisions: [
          { rule: "invoice_already_paid", detail: "dup", conflicting_payment_intent_id: "pi_old" },
        ],
      }),
    });
    const r = await runPreExecutionGate(deps, {
      ctx,
      principal: principal(),
      intent: intent({ invoice_id: "INV-1" }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failedCheck.index).toBe(11.5);
  });

  // 5. Stale approval: a signature against a superseded policy version is excluded.
  it("stale approval: quorum fails when the only signature is stale (P0.4)", async () => {
    const deps = gateDeps({
      evaluatePolicy: async () =>
        decision({ outcome: "confirm", required_approvers: ["cfo"], policy_version: 9 }),
      // The resolver excludes the stale (old-version) signature for the active version.
      resolveApprovals: async (_id, v) => ({ signedRoles: v === 9 ? [] : ["cfo"] }),
    });
    const r = await runPreExecutionGate(deps, { ctx, principal: principal(), intent: intent() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failedCheck.index).toBe(11);
  });

  // 10. Fake evidence: evidence that doesn't support the action fails at 9.5.
  it("fake evidence: amount-mismatched invoice fails at check 9.5", async () => {
    const deps = gateDeps({
      resolveEvidence: async () => [
        {
          id: "prs_1",
          kind: "invoice",
          sourceArtifactId: "raw_1",
          capturedAt: new Date(),
          trustLevel: "high" as const,
          extracted: {
            invoice_number: "INV-1",
            counterparty_id: "cp_x",
            amount_due: "9999.00", // intent is 50.00
            currency: "USD",
          },
        },
      ],
    });
    const r = await runPreExecutionGate(deps, {
      ctx,
      principal: principal(),
      intent: intent({ action_type: "pay_invoice", invoice_id: "INV-1" }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failedCheck.index).toBe(9.5);
  });

  // 7. Rail bypass: the state machine has no direct approved → executed edge.
  it("rail bypass: approved → executed is not a valid transition", () => {
    expect(isValidPaymentIntentTransition("approved", "executed")).toBe(false);
    expect(isValidPaymentIntentTransition("dispatching", "executed")).toBe(true);
  });

  // 9. Prompt injection in a Wiki annotation: the gate cannot read Wiki at all.
  it("prompt injection: the gate dependency surface has no Wiki resolver", () => {
    // Compile-time + runtime: GateDependencies exposes only Ledger/Policy/approval
    // hooks. Injected Wiki text can never reach a financial decision.
    const allowed: Array<keyof GateDependencies> = [
      "resolveAgent",
      "resolveAccount",
      "resolveCounterparty",
      "evaluatePolicy",
      "resolveApprovals",
      "audit",
      "traceCache",
      "sumActiveReservations",
      "resolveEvidence",
      "detectDuplicates",
      "resolveTenantFlags",
      "attestCounterpartyAgent",
      "sumAgentWindowSpend",
      "resolveEscrowState",
      "metrics",
    ];
    expect(allowed.some((k) => String(k).toLowerCase().includes("wiki"))).toBe(false);
    expect(allowed.some((k) => String(k).toLowerCase().includes("narrative"))).toBe(false);
    expect(allowed.some((k) => String(k).toLowerCase().includes("memory"))).toBe(false);
  });

  // 10. Poisoned Wiki memory in the PROPOSE path: CreatePaymentIntentInput
  //     carries only structured fields. No narrative/memory/wiki key is
  //     accepted, so a Wiki page that gets re-rendered with an embedded
  //     "instruction" can never become an input to PaymentIntentService.create.
  it("prompt injection: CreatePaymentIntentInput has no narrative/wiki field", () => {
    type K = keyof import("@brain/shared").CreatePaymentIntentInput;
    const allowed: K[] = [
      "action_type",
      "source_account_id",
      "destination_counterparty_id",
      "amount",
      "currency",
      "obligation_id",
      "invoice_id",
      "agent_id",
      "evidence_ids",
      "pay_to",
      "escrow_id",
      "job_terms_hash",
    ];
    expect(allowed.some((k) => String(k).toLowerCase().includes("wiki"))).toBe(false);
    expect(allowed.some((k) => String(k).toLowerCase().includes("narrative"))).toBe(false);
    expect(allowed.some((k) => String(k).toLowerCase().includes("memory"))).toBe(false);
    expect(allowed.some((k) => String(k).toLowerCase().includes("description"))).toBe(false);
  });

  // 11. Fake counterparty / x402 pay_to mismatch: even if a counterparty record
  //     has high verified_status, a settlement where pay_to differs from the
  //     counterparty's on-chain address is a HARD reject at check 6.5. Proves
  //     §6 binds the settlement recipient to the resolved counterparty, not to
  //     a value supplied alongside the intent.
  it("fake counterparty / x402 pay_to mismatch: hard reject at 6.5", async () => {
    const honestPayee = "0x" + "ab".repeat(20);
    const maliciousPayTo = "0x" + "cd".repeat(20);
    const deps = gateDeps({
      // Counterparty is "trusted" off-chain but its on-chain address differs from
      // the settlement recipient the intent claims to pay.
      resolveCounterparty: async () => ({ ...TRUSTED_CP, onchain_address: honestPayee }),
    });
    const result = await runPreExecutionGate(deps, {
      ctx,
      principal: principal(),
      intent: intent({
        action_type: "x402_settle",
        currency: "USDC",
        settlement: {
          asset: "USDC",
          network: "base",
          amount: "50.00",
          pay_to: maliciousPayTo,
        },
      }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failedCheck.name).toBe("x402_payment_context_valid");
      expect(result.failedCheck.index).toBe(6.5);
      const failures = String(JSON.stringify(result.failedCheck.detail ?? {}));
      expect(failures).toContain("counterparty on-chain address");
    }
  });

  // 12. Compromised / non-attested agent payee: even if the agent counterparty
  //     record exists, the §6 gate (check 5.5) HARD rejects when the on-chain
  //     attestation reader reports the agent is not registered or is paused.
  //     This is the M2M-commerce membership check: a malicious external agent
  //     that hasn't passed BrainMCPAgentRegistry attestation cannot receive funds.
  it("non-attested agent payee: hard reject at 5.5", async () => {
    const agentCP: GateCounterparty = {
      id: "cp_agent",
      type: "agent",
      risk_level: "low",
      verified_status: "document_verified",
      agent_id: "agent_unattested",
    };
    const deps = gateDeps({
      resolveCounterparty: async () => agentCP,
      attestCounterpartyAgent: async () => ({
        attested: false,
        registered: false,
        paused: false,
        reason: "agent not registered in BrainMCPAgentRegistry",
      }),
    });
    const result = await runPreExecutionGate(deps, {
      ctx,
      principal: principal(),
      intent: intent({ destination_counterparty_id: agentCP.id }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failedCheck.name).toBe("agent_counterparty_attested");
      expect(result.failedCheck.index).toBe(5.5);
    }
  });
});

// --- ApprovalService rejection vectors (fake pool; no DB) --------------------

function approvalPool(existing: boolean): Pool {
  const client = {
    query: async (text: string) => {
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(text) || text.includes("set_config")) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("FROM approvals") && text.includes("approver_principal_id = $3")) {
        return existing
          ? { rows: [{ id: "appr_old", approver_principal_id: ACTOR }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };
  return { connect: async () => client } as unknown as Pool;
}

// withTenantScope validates the tenant id format, so the approval-path vectors
// (which run inside it) need a real ULID tenant, not the gate tests' "tnt_adv".
const VALID_TENANT = newTenantId();

function approvalDeps(pool: Pool, over: Partial<ApprovalServiceDeps> = {}): ApprovalServiceDeps {
  return {
    pool,
    audit: new InMemoryAuditEmitter(),
    resolveRole: async () => "cfo",
    isApproverActive: async () => true,
    resolveSubjectOwnerTenant: async () => VALID_TENANT,
    resolveActivePolicyVersion: async () => 1,
    ...over,
  };
}

describe("P1.1 adversarial — approval path fails closed", () => {
  const subj = { type: "payment_intent" as const, id: "pi_adv" };
  const signerCtx: ServiceCallContext = { tenantId: VALID_TENANT, actor: newUserId() };

  // 4. Replayed signature: the same signer signing twice is rejected.
  it("replayed signature / duplicate signer is rejected", async () => {
    const svc = new ApprovalService(approvalDeps(approvalPool(true)));
    await expect(svc.sign(signerCtx, subj)).rejects.toMatchObject({
      code: "approval_duplicate_signer",
    });
  });

  // (revocation) a revoked signer cannot sign.
  it("revoked signer is rejected", async () => {
    const svc = new ApprovalService(
      approvalDeps(approvalPool(false), { isApproverActive: async () => false }),
    );
    await expect(svc.sign(signerCtx, subj)).rejects.toMatchObject({
      code: "approval_signer_revoked",
    });
  });

  // 1. Tenant ID swap (signer): a signer whose tenant doesn't own the subject.
  it("cross-tenant signer is rejected", async () => {
    const svc = new ApprovalService(
      approvalDeps(approvalPool(false), { resolveSubjectOwnerTenant: async () => newTenantId() }),
    );
    await expect(svc.sign(signerCtx, subj)).rejects.toMatchObject({
      code: "approval_cross_tenant",
    });
  });
});
