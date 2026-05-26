/**
 * §6 gate — x402 / on-chain settlement checks (RFC 0001 §6, Phase 2B).
 *
 * Four new "hardening addition" checks, numbered in the existing 1.5 / 7.5 / 9.5
 * / 11.5 style and gated behind their loader/field so the canonical happy path is
 * byte-identical when they are unwired (mirrors check 1.5):
 *
 *   3.5  onchain_settlement_permitted  — tenant/payment-class may settle on-chain
 *   5.5  agent_counterparty_attested   — agent payee is registered + attested
 *   6.5  x402_payment_context_valid    — USDC/Base/amount/recipient match intent
 *   8.5  micropayment_cap_within_window — per-agent rolling-window spend cap
 *
 * Determinism is preserved (Standards §6, Principle #5): every new check is a
 * field comparison or a registry/spend read — no LLM, no reputation-as-gate.
 */

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
const PAY_TO = "0x" + "ab".repeat(20);
const AGENT_ID = "agent_01J0000000000000000000000A";

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

/** A fully-formed x402 settlement intent (currency USDC, settlement context). */
function x402Intent(overrides: Partial<GatePaymentIntent> = {}): GatePaymentIntent {
  return defaultIntent({
    action_type: "x402_settle",
    currency: "USDC",
    amount: "1.00",
    destination_counterparty_id: "cp_agent",
    settlement: { asset: "USDC", network: "base", amount: "1.00", pay_to: PAY_TO },
    ...overrides,
  });
}

function defaultPrincipal(overrides: Partial<GatePrincipal> = {}): GatePrincipal {
  return { id: ACTOR, type: "agent", scopes: ["payment_intent:execute"], ...overrides };
}

const ACTIVE_AGENT: GateAgent = {
  id: ACTOR,
  state: "active",
  scope: { canExecutePayments: true },
};

const USD_ACCOUNT: GateAccount = {
  id: "acct_X",
  status: "active",
  currency: "USD",
  available_balance: "1000.00",
};

const USDC_ACCOUNT: GateAccount = {
  id: "acct_X",
  status: "active",
  currency: "USDC",
  available_balance: "1000.00",
};

const TRUSTED_CP: GateCounterparty = {
  id: "cp_AWS",
  type: "vendor",
  risk_level: "low",
  verified_status: "document_verified",
};

/** An agent payee with a matching on-chain address (the x402 recipient). */
const AGENT_CP: GateCounterparty = {
  id: "cp_agent",
  type: "agent",
  risk_level: "low",
  verified_status: "document_verified",
  agent_id: AGENT_ID,
  onchain_address: PAY_TO,
};

function makeDecision(overrides: Partial<GatePolicyDecision> = {}): GatePolicyDecision {
  return {
    id: "pd_TEST",
    outcome: "allow",
    matched_rule_id: "ok",
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
    resolveAccount: async () => USD_ACCOUNT,
    resolveCounterparty: async () => TRUSTED_CP,
    evaluatePolicy: async () => makeDecision(),
    resolveApprovals: async (): Promise<GateApprovalState> => ({ signedRoles: [] }),
    ...overrides,
  };
  return { deps, audit };
}

const ctx = { tenantId: TENANT, actor: ACTOR };

function run(deps: GateDependencies, intent: GatePaymentIntent, dryRun = false) {
  return runPreExecutionGate(deps, { ctx, principal: defaultPrincipal(), intent, dryRun });
}

// ---------------------------------------------------------------------------
// Regression: the additions are dormant when unwired (canonical 16-check path).
// ---------------------------------------------------------------------------

describe("§6 x402 additions — dormant when unwired (canonical path preserved)", () => {
  it("a non-settlement ACH intent with no new deps yields exactly the canonical 16 checks", async () => {
    const { deps } = makeDeps();
    const result = await run(deps, defaultIntent());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.checks.map((c) => c.index)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 7.5, 8, 9, 9.5, 10, 11, 11.5, 12, 13,
      ]);
      const newNames = [
        "onchain_settlement_permitted",
        "agent_counterparty_attested",
        "x402_payment_context_valid",
        "micropayment_cap_within_window",
      ];
      expect(result.checks.some((c) => newNames.includes(c.name))).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 3.5 — on-chain settlement permitted
// ---------------------------------------------------------------------------

describe("§6 — check 3.5: on-chain settlement permitted (RFC 0001 §6.5)", () => {
  const settlementDeps = (over: Partial<GatePolicyDecision> = {}) =>
    makeDeps({
      resolveAccount: async () => USDC_ACCOUNT,
      resolveCounterparty: async () => AGENT_CP,
      evaluatePolicy: async () => makeDecision(over),
    });

  it("passes when policy permits on-chain settlement", async () => {
    const { deps } = settlementDeps({ onchain_settlement_permitted: true });
    const result = await run(deps, x402Intent());
    expect(result.ok).toBe(true);
    if (result.ok) {
      const row = result.checks.find((c) => c.name === "onchain_settlement_permitted");
      expect(row?.passed).toBe(true);
      expect(row?.detail?.not_applicable).toBeUndefined();
      expect(row?.index).toBe(3.5);
    }
  });

  it("HARD-fails closed at 3.5 when policy forbids on-chain settlement", async () => {
    const { deps } = settlementDeps({ onchain_settlement_permitted: false });
    const result = await run(deps, x402Intent());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failedCheck.index).toBe(3.5);
      expect(result.failedCheck.name).toBe("onchain_settlement_permitted");
      // short-circuits before source-account (4) ever runs.
      expect(result.checks.some((c) => c.index === 4)).toBe(false);
    }
  });

  it("records not_applicable when the policy dimension is unexpressed (undefined)", async () => {
    const { deps } = settlementDeps(); // no onchain_settlement_permitted
    const result = await run(deps, x402Intent());
    expect(result.ok).toBe(true);
    if (result.ok) {
      const row = result.checks.find((c) => c.name === "onchain_settlement_permitted");
      expect(row?.passed).toBe(true);
      expect(row?.detail?.not_applicable).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 5.5 — agent-counterparty attestation
// ---------------------------------------------------------------------------

describe("§6 — check 5.5: agent-counterparty attestation (RFC 0001 §6.3)", () => {
  it("passes and threads counterparty id + agent_id to the reader", async () => {
    let seen: { counterpartyId: string; agentId: string | null } | null = null;
    const { deps } = makeDeps({
      resolveAccount: async () => USDC_ACCOUNT,
      resolveCounterparty: async () => AGENT_CP,
      evaluatePolicy: async () => makeDecision({ onchain_settlement_permitted: true }),
      attestCounterpartyAgent: async (input) => {
        seen = { counterpartyId: input.counterpartyId, agentId: input.agentId };
        return { attested: true, registered: true, paused: false };
      },
    });
    const result = await run(deps, x402Intent());
    expect(result.ok).toBe(true);
    expect(seen).toEqual({ counterpartyId: "cp_agent", agentId: AGENT_ID });
    if (result.ok) {
      const row = result.checks.find((c) => c.name === "agent_counterparty_attested");
      expect(row?.passed).toBe(true);
      expect(row?.index).toBe(5.5);
    }
  });

  it("HARD-rejects at 5.5 when the agent payee is not attested", async () => {
    const { deps } = makeDeps({
      resolveAccount: async () => USDC_ACCOUNT,
      resolveCounterparty: async () => AGENT_CP,
      evaluatePolicy: async () => makeDecision({ onchain_settlement_permitted: true }),
      attestCounterpartyAgent: async () => ({
        attested: false,
        registered: true,
        paused: true,
        reason: "agent paused",
      }),
    });
    const result = await run(deps, x402Intent());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failedCheck.index).toBe(5.5);
      expect(result.failedCheck.detail!.paused).toBe(true);
      expect(result.checks.some((c) => c.index === 6)).toBe(false); // short-circuits
    }
  });

  it("records not_applicable when the reader is wired but the payee is not an agent", async () => {
    const { deps } = makeDeps({
      attestCounterpartyAgent: async () => ({ attested: true }),
    });
    const result = await run(deps, defaultIntent()); // vendor counterparty
    expect(result.ok).toBe(true);
    if (result.ok) {
      const row = result.checks.find((c) => c.name === "agent_counterparty_attested");
      expect(row?.passed).toBe(true);
      expect(row?.detail?.not_applicable).toBe(true);
    }
  });

  it("adds no row when the reader is unwired (canonical path)", async () => {
    const { deps } = makeDeps({
      resolveAccount: async () => USDC_ACCOUNT,
      resolveCounterparty: async () => AGENT_CP,
      evaluatePolicy: async () => makeDecision({ onchain_settlement_permitted: true }),
    });
    const result = await run(deps, x402Intent());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.checks.some((c) => c.name === "agent_counterparty_attested")).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 6.5 — x402 payment-context validation
// ---------------------------------------------------------------------------

describe("§6 — check 6.5: x402 payment-context validation (RFC 0001 §6.1)", () => {
  const ctxDeps = () =>
    makeDeps({
      resolveAccount: async () => USDC_ACCOUNT,
      resolveCounterparty: async () => AGENT_CP,
      evaluatePolicy: async () => makeDecision({ onchain_settlement_permitted: true }),
    });

  it("passes when asset/network/amount/recipient all match the intent + payee", async () => {
    const { deps } = ctxDeps();
    const result = await run(deps, x402Intent());
    expect(result.ok).toBe(true);
    if (result.ok) {
      const row = result.checks.find((c) => c.name === "x402_payment_context_valid");
      expect(row?.passed).toBe(true);
      expect(row?.index).toBe(6.5);
    }
  });

  it("matches the recipient address case-insensitively", async () => {
    const { deps } = makeDeps({
      resolveAccount: async () => USDC_ACCOUNT,
      resolveCounterparty: async () => ({ ...AGENT_CP, onchain_address: PAY_TO.toUpperCase() }),
      evaluatePolicy: async () => makeDecision({ onchain_settlement_permitted: true }),
    });
    const result = await run(deps, x402Intent());
    expect(result.ok).toBe(true);
  });

  it.each([
    ["non-USDC asset", { asset: "DAI", network: "base", amount: "1.00", pay_to: PAY_TO }],
    ["non-Base network", { asset: "USDC", network: "ethereum", amount: "1.00", pay_to: PAY_TO }],
    ["amount mismatch", { asset: "USDC", network: "base", amount: "2.00", pay_to: PAY_TO }],
    ["malformed pay_to", { asset: "USDC", network: "base", amount: "1.00", pay_to: "alice" }],
  ])("HARD-fails at 6.5 on %s", async (_label, settlement) => {
    const { deps } = ctxDeps();
    const result = await run(deps, x402Intent({ settlement }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failedCheck.index).toBe(6.5);
      expect(result.failedCheck.name).toBe("x402_payment_context_valid");
      expect(Array.isArray(result.failedCheck.detail!.failures)).toBe(true);
    }
  });

  it("fails when the intent currency does not match the settled asset", async () => {
    const { deps } = ctxDeps();
    const result = await run(deps, x402Intent({ currency: "USD" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failedCheck.index).toBe(6.5);
  });

  it("fails when the counterparty has no on-chain address (recipient unverifiable)", async () => {
    const { deps } = makeDeps({
      resolveAccount: async () => USDC_ACCOUNT,
      resolveCounterparty: async () => ({ ...AGENT_CP, onchain_address: null }),
      evaluatePolicy: async () => makeDecision({ onchain_settlement_permitted: true }),
    });
    const result = await run(deps, x402Intent());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failedCheck.index).toBe(6.5);
  });
});

// ---------------------------------------------------------------------------
// 8.5 — micropayment cumulative cap
// ---------------------------------------------------------------------------

describe("§6 — check 8.5: micropayment cumulative cap (RFC 0001 §6.4)", () => {
  const capDeps = (
    cap: GatePolicyDecision["micropayment_window_cap"],
    sum: GateDependencies["sumAgentWindowSpend"],
  ) =>
    makeDeps({
      resolveAccount: async () => USDC_ACCOUNT,
      resolveCounterparty: async () => AGENT_CP,
      evaluatePolicy: async () =>
        makeDecision({
          onchain_settlement_permitted: true,
          ...(cap !== undefined ? { micropayment_window_cap: cap } : {}),
        }),
      ...(sum !== undefined ? { sumAgentWindowSpend: sum } : {}),
    });

  it("passes when window spend + amount stays within the cap and threads agent id + window", async () => {
    let seen: { agentId: string; windowSeconds: number } | null = null;
    const { deps } = capDeps(
      { currency: "USDC", value: "10.00", window_seconds: 3600 },
      async (a, w) => {
        seen = { agentId: a, windowSeconds: w };
        return "5.00";
      },
    );
    const result = await run(deps, x402Intent());
    expect(result.ok).toBe(true);
    expect(seen).toEqual({ agentId: ACTOR, windowSeconds: 3600 });
    if (result.ok) {
      const row = result.checks.find((c) => c.name === "micropayment_cap_within_window");
      expect(row?.passed).toBe(true);
      expect(row?.index).toBe(8.5);
    }
  });

  it("HARD-rejects at 8.5 when window spend + amount exceeds the cap", async () => {
    const { deps } = capDeps(
      { currency: "USDC", value: "10.00", window_seconds: 3600 },
      async () => "9.50",
    );
    const result = await run(deps, x402Intent()); // 9.50 + 1.00 = 10.50 > 10.00
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failedCheck.index).toBe(8.5);
      expect(result.failedCheck.detail!.window_spend).toBe("9.50");
      expect(result.checks.some((c) => c.index === 9)).toBe(false); // short-circuits
    }
  });

  it("fails on currency mismatch between the intent and the window cap", async () => {
    const { deps } = capDeps(
      { currency: "USD", value: "10.00", window_seconds: 3600 },
      async () => "0",
    );
    const result = await run(deps, x402Intent());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failedCheck.index).toBe(8.5);
  });

  it("adds no row when the cap is set but the reader is unwired", async () => {
    const { deps } = capDeps({ currency: "USDC", value: "10.00", window_seconds: 3600 }, undefined);
    const result = await run(deps, x402Intent());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.checks.some((c) => c.name === "micropayment_cap_within_window")).toBe(false);
    }
  });

  it("adds no row when the reader is wired but no cap is expressed", async () => {
    const { deps } = capDeps(undefined, async () => "0");
    const result = await run(deps, x402Intent());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.checks.some((c) => c.name === "micropayment_cap_within_window")).toBe(false);
    }
  });

  it("enforces the cap in dry-run too (read-only), emitting no audit", async () => {
    const { deps, audit } = capDeps(
      { currency: "USDC", value: "10.00", window_seconds: 3600 },
      async () => "9.50",
    );
    const result = await run(deps, x402Intent(), true);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failedCheck.index).toBe(8.5);
    expect(audit.events).toHaveLength(0);
  });

  it("property: passes iff windowSpend + amount ≤ cap", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 1_000_00 }),
        fc.integer({ min: 1, max: 1_000_00 }),
        fc.integer({ min: 0, max: 1_000_00 }),
        async (amountCents, capCents, spentCents) => {
          const amount = (amountCents / 100).toFixed(2);
          const cap = (capCents / 100).toFixed(2);
          const spent = (spentCents / 100).toFixed(2);
          const { deps } = capDeps(
            { currency: "USDC", value: cap, window_seconds: 3600 },
            async () => spent,
          );
          const result = await run(
            deps,
            x402Intent({
              amount,
              settlement: { asset: "USDC", network: "base", amount, pay_to: PAY_TO },
            }),
          );
          const expectOk = amountCents + spentCents <= capCents;
          // (other checks pass for these fixtures; 8.5 is the only variable)
          if (expectOk) {
            expect(result.ok).toBe(true);
          } else {
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.failedCheck.index).toBe(8.5);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// End-to-end: a fully-wired x402 settlement threads all new checks + reaches 13.
// ---------------------------------------------------------------------------

describe("§6 — x402 happy path threads 3.5 / 5.5 / 6.5 / 8.5 then audit-before", () => {
  it("passes every check including the four additions and emits one audit-before", async () => {
    const { deps, audit } = makeDeps({
      resolveAccount: async () => USDC_ACCOUNT,
      resolveCounterparty: async () => AGENT_CP,
      evaluatePolicy: async () =>
        makeDecision({
          onchain_settlement_permitted: true,
          micropayment_window_cap: { currency: "USDC", value: "100.00", window_seconds: 3600 },
        }),
      attestCounterpartyAgent: async () => ({ attested: true, registered: true, paused: false }),
      sumAgentWindowSpend: async () => "0",
    });
    const result = await run(deps, x402Intent());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.checks.map((c) => c.index)).toEqual([
        1, 2, 3, 3.5, 4, 5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10, 11, 11.5, 12, 13,
      ]);
      expect(result.checks.every((c) => c.passed)).toBe(true);
    }
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]!.action).toBe("payment_intent.execute.before");
  });
});
