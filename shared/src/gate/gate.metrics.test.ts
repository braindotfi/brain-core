/**
 * §6 gate — metrics emission (recommendations item 11).
 *
 * The gate is the single most security-critical hot path. Once the dormant
 * loaders enforce on Sepolia, operating without per-check counters and a
 * gate-outcome rate is flying blind. The instrumentation lives in gate.ts and
 * is fire-and-forget; this suite pins the emission contract so a future
 * refactor cannot quietly drop the signal.
 */

import { describe, expect, it } from "vitest";
import { MockMetrics } from "../metrics.js";
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

function defaultIntent(): GatePaymentIntent {
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
  };
}

function defaultPrincipal(): GatePrincipal {
  return { id: ACTOR, type: "agent", scopes: ["payment_intent:execute"] };
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

function makeDecision(): GatePolicyDecision {
  return {
    id: "pd_TEST",
    outcome: "allow",
    matched_rule_id: "small-payments-ok",
    required_approvers: [],
    ledger_snapshot_hash: "0xdeadbeef",
    trace: [],
  };
}

function makeDeps(overrides: Partial<GateDependencies> = {}): GateDependencies {
  return {
    audit: new InMemoryAuditEmitter(),
    resolveAgent: async () => ACTIVE_AGENT,
    resolveAccount: async () => ACTIVE_ACCOUNT,
    resolveCounterparty: async () => TRUSTED_CP,
    evaluatePolicy: async () => makeDecision(),
    resolveApprovals: async (): Promise<GateApprovalState> => ({ signedRoles: [] }),
    ...overrides,
  };
}

const ctx = { tenantId: TENANT, actor: ACTOR };

describe("§6 gate — metrics emission (item 11)", () => {
  it("emits outcome=ok + per-check counters + duration on a happy-path pass", async () => {
    const metrics = new MockMetrics();
    const result = await runPreExecutionGate(makeDeps({ metrics }), {
      ctx,
      principal: defaultPrincipal(),
      intent: defaultIntent(),
    });
    expect(result.ok).toBe(true);

    const outcomeCalls = metrics.calls.filter((c) => c.name === "brain.gate.outcome.count");
    expect(outcomeCalls).toHaveLength(1);
    expect(outcomeCalls[0]!.tags).toMatchObject({ outcome: "ok", dry_run: false });

    const durationCalls = metrics.calls.filter((c) => c.name === "brain.gate.duration_ms");
    expect(durationCalls).toHaveLength(1);
    expect(durationCalls[0]!.kind).toBe("duration");
    expect(durationCalls[0]!.tags).toMatchObject({ outcome: "ok", dry_run: false });
    expect(durationCalls[0]!.value).toBeGreaterThanOrEqual(0);

    if (!result.ok) return; // refines for TS
    // One check counter per check the gate produced.
    const checkCalls = metrics.calls.filter((c) => c.name === "brain.gate.check.count");
    expect(checkCalls).toHaveLength(result.checks.length);
    // Every emitted check tag is pass or not_applicable on a passing gate.
    for (const cc of checkCalls) {
      const o = cc.tags?.outcome;
      expect(o === "pass" || o === "not_applicable").toBe(true);
    }
  });

  it("a failing check emits outcome=fail and NEVER pass for the same check name", async () => {
    const metrics = new MockMetrics();
    // resolveAgent returning null fails check 1 (agent_identity_verified).
    const result = await runPreExecutionGate(
      makeDeps({ metrics, resolveAgent: async () => null }),
      {
        ctx,
        principal: defaultPrincipal(),
        intent: defaultIntent(),
      },
    );
    expect(result.ok).toBe(false);

    const outcomeCalls = metrics.calls.filter((c) => c.name === "brain.gate.outcome.count");
    expect(outcomeCalls).toHaveLength(1);
    expect(outcomeCalls[0]!.tags).toMatchObject({ outcome: "fail", dry_run: false });

    const failingCheck = "agent_identity_verified";
    const sameCheckCounters = metrics.calls.filter(
      (c) => c.name === "brain.gate.check.count" && c.tags?.check === failingCheck,
    );
    // Exactly one counter for this check, with outcome=fail. Never pass.
    expect(sameCheckCounters).toHaveLength(1);
    expect(sameCheckCounters[0]!.tags).toMatchObject({ check: failingCheck, outcome: "fail" });
    expect(
      metrics.calls.some(
        (c) =>
          c.name === "brain.gate.check.count" &&
          c.tags?.check === failingCheck &&
          c.tags?.outcome === "pass",
      ),
    ).toBe(false);
  });

  it("emits nothing when metrics is not wired (safe default)", async () => {
    // No metrics dep — gate must still run without throwing.
    const result = await runPreExecutionGate(makeDeps(), {
      ctx,
      principal: defaultPrincipal(),
      intent: defaultIntent(),
    });
    expect(result.ok).toBe(true);
  });

  it("tags dry_run=true when running in dry-run mode", async () => {
    const metrics = new MockMetrics();
    await runPreExecutionGate(makeDeps({ metrics }), {
      ctx,
      principal: defaultPrincipal(),
      intent: defaultIntent(),
      dryRun: true,
    });
    const outcome = metrics.calls.find((c) => c.name === "brain.gate.outcome.count");
    expect(outcome?.tags).toMatchObject({ outcome: "ok", dry_run: true });
  });
});
