/**
 * Section 6 counterparty trust gate. The feature is deliberately disabled by default;
 * these tests pin both the fail-closed enabled path and the unchanged legacy
 * trace while it remains off.
 */

import { describe, expect, it, vi } from "vitest";
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

const tenantId = "tnt_counterparty_trust";
const agentId = "agent_counterparty_trust";

const principal: GatePrincipal = {
  id: agentId,
  type: "agent",
  scopes: ["payment_intent:execute"],
};
const intent: GatePaymentIntent = {
  id: "pi_counterparty_trust",
  owner_id: tenantId,
  created_by_agent_id: agentId,
  action_type: "ach_outbound",
  source_account_id: "acct_counterparty_trust",
  destination_counterparty_id: "cp_counterparty_trust",
  amount: "10.00",
  currency: "USD",
  status: "approved",
  policy_decision_id: null,
  evidence_ids: [],
};
const agent: GateAgent = {
  id: agentId,
  state: "active",
  scope: { canExecutePayments: true },
};
const account: GateAccount = {
  id: intent.source_account_id,
  status: "active",
  currency: "USD",
  available_balance: "100.00",
};
const decision: GatePolicyDecision = {
  id: "pd_counterparty_trust",
  outcome: "allow",
  matched_rule_id: "allow-payment",
  required_approvers: [],
  ledger_snapshot_hash: "snapshot",
  trace: [],
  ach_autonomous_max_amount: { currency: "USD", value: "100.00" },
};

function counterparty(
  trust_status: Exclude<GateCounterparty["trust_status"], undefined>,
): GateCounterparty {
  return {
    id: intent.destination_counterparty_id,
    type: "vendor",
    risk_level: "low",
    verified_status: "document_verified",
    trust_status,
  };
}

function deps(overrides: Partial<GateDependencies> = {}): GateDependencies {
  return {
    audit: new InMemoryAuditEmitter(),
    resolveAgent: async () => agent,
    resolveAccount: async () => account,
    resolveCounterparty: async () => counterparty("trusted"),
    evaluatePolicy: async () => decision,
    resolveApprovals: async (): Promise<GateApprovalState> => ({ signedRoles: [] }),
    ...overrides,
  };
}

function run(overrides: Partial<GateDependencies> = {}) {
  return runPreExecutionGate(deps(overrides), {
    ctx: { tenantId, actor: agentId },
    principal,
    intent,
  });
}

describe("section 6 gate counterparty trust", () => {
  it.each(["trusted", "unreviewed", "acknowledged"] as const)(
    "allows %s counterparties when enabled",
    async (trust_status) => {
      const result = await run({
        trustGateEnabled: true,
        resolveCounterparty: async () => counterparty(trust_status),
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.checks).toContainEqual({
          index: 5.25,
          name: "counterparty_trust_allowed",
          passed: true,
          detail: { trust_status },
        });
      }
    },
  );

  it.each([
    ["allowing", decision],
    ["rejecting", { ...decision, outcome: "reject" as const, matched_rule_id: "block-all" }],
  ])(
    "denies paused counterparties before an %s policy can mask the trust reason",
    async (_label, policy) => {
      const evaluatePolicy = vi.fn(async () => policy);
      const result = await run({
        trustGateEnabled: true,
        resolveCounterparty: async () => counterparty("paused"),
        evaluatePolicy,
      });
      expect(result).toMatchObject({
        ok: false,
        failedCheck: {
          index: 5.25,
          name: "counterparty_trust_allowed",
          detail: {
            reason: "counterparty_trust_paused",
            trust_status: "paused",
          },
        },
      });
      expect(evaluatePolicy).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["missing trust status", async () => counterparty(null)],
    ["unknown trust status", async () => counterparty("legacy" as string)],
  ])("fails closed for %s", async (_label, resolveCounterparty) => {
    const result = await run({ trustGateEnabled: true, resolveCounterparty });
    expect(result).toMatchObject({
      ok: false,
      failedCheck: {
        index: 5.25,
        name: "counterparty_trust_allowed",
        detail: { reason: "counterparty_trust_unknown" },
      },
    });
  });

  it("denies an unknown trust status before a rejecting policy can mask the trust reason", async () => {
    const evaluatePolicy = vi.fn(async () => ({
      ...decision,
      outcome: "reject" as const,
      matched_rule_id: "block-all",
    }));
    const result = await run({
      trustGateEnabled: true,
      resolveCounterparty: async () => counterparty("legacy" as string),
      evaluatePolicy,
    });
    expect(result).toMatchObject({
      ok: false,
      failedCheck: {
        index: 5.25,
        name: "counterparty_trust_allowed",
        detail: { reason: "counterparty_trust_unknown", trust_status: "legacy" },
      },
    });
    expect(evaluatePolicy).not.toHaveBeenCalled();
  });

  it("preserves the legacy Check 5 missing-counterparty failure while enabled", async () => {
    const missing = async () => null;
    const flagOff = await run({ resolveCounterparty: missing });
    const flagOn = await run({ trustGateEnabled: true, resolveCounterparty: missing });
    expect(flagOn).toMatchObject({
      ok: false,
      failedCheck: {
        index: 5,
        name: "counterparty_allowed",
        detail: { reason: "counterparty not found" },
      },
    });
    expect(flagOn.ok).toBe(false);
    expect(flagOff.ok).toBe(false);
    if (flagOn.ok || flagOff.ok) throw new Error("missing counterparty unexpectedly passed");
    expect(flagOn.failedCheck).toEqual(flagOff.failedCheck);
  });

  it("fails closed when the shared counterparty loader throws", async () => {
    const result = await run({
      trustGateEnabled: true,
      resolveCounterparty: async () => {
        throw new Error("database unavailable");
      },
    });
    expect(result).toMatchObject({
      ok: false,
      failedCheck: {
        index: 5.25,
        name: "counterparty_trust_allowed",
        detail: { reason: "counterparty_trust_unknown", loader_failure: true },
      },
    });
  });

  it("threads the gate-time trust enum into policy input when enabled", async () => {
    const evaluatePolicy = vi.fn(async () => decision);
    const resolveCounterparty = vi.fn(async () => counterparty("acknowledged"));
    await run({
      trustGateEnabled: true,
      resolveCounterparty,
      evaluatePolicy,
    });
    expect(evaluatePolicy).toHaveBeenCalledWith(
      expect.objectContaining({ counterparty_trust_status: "acknowledged" }),
      { dryRun: false },
    );
    expect(resolveCounterparty).toHaveBeenCalledTimes(1);
  });

  it("keeps the legacy trace byte-for-byte unchanged while disabled", async () => {
    const paused = async () => counterparty("paused");
    const implicitOff = await run({ resolveCounterparty: paused });
    const explicitOff = await run({ trustGateEnabled: false, resolveCounterparty: paused });
    const trace = (result: typeof implicitOff) => ({
      ok: result.ok,
      outcome: result.outcome,
      requiredApprovers: result.requiredApprovers,
      checks: result.checks.map((check) => ({
        ...check,
        detail:
          check.name === "audit_before_emitted" ? { audit_event_id: "generated" } : check.detail,
      })),
    });
    // The event id is intentionally generated per invocation. Every decision
    // and check before that generated identifier must remain identical.
    expect(trace(implicitOff)).toEqual(trace(explicitOff));
    expect(implicitOff.ok).toBe(true);
    if (implicitOff.ok) {
      expect(implicitOff.checks.map((check) => check.name)).not.toContain(
        "counterparty_trust_allowed",
      );
    }
  });
});
