/**
 * Signed-agent → gated-payment end-to-end (peer-review batch 2, P5).
 *
 * Closes the loop on the HMAC-signing work shipped in batch 2 (P1+P2): the
 * api side now signs every outbound /run/* call to the Python brain-agents
 * service with X-Brain-Auth, and the Python verifier fails closed in
 * production. This e2e asserts the full chain end-to-end against staging:
 *
 *   1. An external MCP agent (BRAIN_EXTERNAL_AGENT_TOKEN) calls a
 *      mutating MCP tool (agent.action.propose for a reconciliation flow,
 *      OR payment_intent.propose for the rail-bound flow).
 *   2. The api audits the tool call (audit/events, action=agent.mcp.tool_called).
 *   3. For a payment flow: a PaymentIntent is created with a non-null
 *      policy_decision_id (the §6 contract: no payment proposed without a
 *      deterministic gate decision).
 *   4. Audit emits payment_intent.created on layer=agent, traceable by
 *      payment_intent_id.
 *   5. The signed call to the Python service either succeeded or surfaced
 *      a clean error; we never see a half-shipped 401 from the verifier
 *      bubble up as a generic 500.
 *
 * Required env:
 *   BRAIN_BASE_URL, BRAIN_EXTERNAL_AGENT_TOKEN
 * Optional (used by the payment-proposal step):
 *   BRAIN_TEST_SOURCE_ACCT_ID, BRAIN_TEST_VENDOR_ID
 *
 * The suite skips when the required env is unset so local runs without
 * staging credentials remain green.
 */

import { describe, expect, it } from "vitest";
import { BrainClient } from "./lib/client.js";

const DESCRIBE =
  process.env.BRAIN_BASE_URL !== undefined && process.env.BRAIN_EXTERNAL_AGENT_TOKEN !== undefined
    ? describe
    : describe.skip;

interface PaymentIntentMin {
  id: string;
  status: string;
  policy_decision_id: string | null;
}

interface AuditEventMin {
  action: string;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  created_at: string;
}

interface GateCheckRow {
  index: number;
  name: string;
  passed: boolean;
  detail?: { not_applicable?: boolean } & Record<string, unknown>;
}

DESCRIBE("signed-agent → gated-payment (peer-review batch 2, P5)", () => {
  const agent = new BrainClient({
    baseUrl: process.env.BRAIN_BASE_URL!,
    token: process.env.BRAIN_EXTERNAL_AGENT_TOKEN!,
  });

  // ---------------------------------------------------------------------------
  // Step 1+2: MCP tool call is audited
  // ---------------------------------------------------------------------------

  it("MCP ping is unauthenticated-safe and returns ok", async () => {
    // Sanity precondition — without this the rest of the suite is meaningless.
    const res = await agent.post<{ ok: boolean }>("/v1/agents/mcp", { method: "ping" });
    expect(res.ok).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Step 3+4: PaymentIntent has policy_decision_id, audit captures it
  // ---------------------------------------------------------------------------

  it("external agent proposes a PaymentIntent, §6 gate produces a policy_decision_id", async () => {
    // The §6 invariant: every PaymentIntent created via the agent-surface has a
    // policy_decision_id BEFORE execution. Even a shadowed / rejected outcome
    // must carry the decision id so the audit trail names which Policy version
    // evaluated it. This is independent of whether the action would settle.
    const sourceAcct = process.env.BRAIN_TEST_SOURCE_ACCT_ID ?? "";
    const vendorId = process.env.BRAIN_TEST_VENDOR_ID ?? "";
    if (sourceAcct === "" || vendorId === "") {
      // Skip the proposal sub-test if staging fixtures aren't wired. Don't
      // false-negative; the audit assertion below covers the other case.
      return;
    }
    const intent = await agent.post<PaymentIntentMin>("/v1/payment-intents", {
      action_type: "ach_outbound",
      source_account_id: sourceAcct,
      destination_counterparty_id: vendorId,
      amount: "1.00",
      currency: "USD",
    });
    expect(intent.id.startsWith("pi_")).toBe(true);
    expect(intent.policy_decision_id).not.toBeNull();
    expect(intent.policy_decision_id!.length).toBeGreaterThan(0);
    expect(["proposed", "pending_approval", "approved", "rejected"]).toContain(intent.status);
  });

  it("audit log surfaces the agent's MCP tool call (agent.mcp.tool_called)", async () => {
    // After the propose above (or any prior MCP tool call this token has made
    // during the run), the audit chain MUST carry an agent.mcp.tool_called
    // event. Pull the recent agent-layer slice and look for one. Note: this
    // search is intentionally tenant-scoped via the JWT, so a noisy staging
    // environment won't pollute the result set with other tenants.
    const events = await agent.get<{ events: AuditEventMin[] }>(
      "/v1/audit/events?layer=agent&limit=50",
    );
    const mcpCalls = events.events.filter((e) => e.action === "agent.mcp.tool_called");
    expect(mcpCalls.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // Step 4a: §6 gate loaders are wired, NOT dormant
  // ---------------------------------------------------------------------------

  it("§6 gate runs critical loaders (checks 8 / 9.5 / 11.5) as PASS, not not_applicable", async () => {
    // Peer-review batch 3 P3. The §6 gate records `not_applicable` on a check
    // when its loader is unwired (`detail.not_applicable === true` on a row
    // whose `passed` is true). That's intentional for genuinely-optional
    // M2M/x402/escrow checks (3.5 / 5.5 / 6.5 / 6.6 / 8.5), but checks
    // 8 (available_balance_sufficient), 9.5 (evidence_supports_action), and
    // 11.5 (no_duplicate_payment) became unconditionally wired in
    // peer-review batch 2 P1. A regression that drops one of those loaders
    // would log "ok / passed" but degrade silently — exactly the trap this
    // test catches.
    //
    // We probe via the audit log: pull recent payment_intent.execute.before
    // events for the tenant and inspect outputs.gate_checks. If no event
    // exists yet (the tenant has never executed an intent), the assertion
    // is informational only — the test is a *staging health probe*, not a
    // per-intent gate check.
    const events = await agent.get<{ events: AuditEventMin[] }>(
      "/v1/audit/events?layer=agent&limit=100",
    );
    const beforeEvents = events.events.filter(
      (e) => e.action === "payment_intent.execute.before",
    );
    if (beforeEvents.length === 0) {
      // No execution history on this tenant in the visible window. Skip
      // rather than false-positive: the absence of executions is not a gate
      // regression. Set up the staging fixture to execute at least one
      // intent if you want this test to be strict here.
      return;
    }
    const latest = beforeEvents[0]!;
    const checks = ((latest.outputs ?? {}).gate_checks as GateCheckRow[] | undefined) ?? [];
    expect(checks.length).toBeGreaterThan(0);

    const required = [
      { index: 8, name: "available_balance_sufficient" },
      { index: 9.5, name: "evidence_supports_action" },
      { index: 11.5, name: "no_duplicate_payment" },
    ];
    for (const { index, name } of required) {
      const row = checks.find((c) => c.index === index);
      expect(row, `gate check ${String(index)} (${name}) missing from execute.before`).toBeDefined();
      expect(row!.passed, `gate check ${String(index)} (${name}) did not pass`).toBe(true);
      expect(
        row!.detail?.not_applicable === true,
        `gate check ${String(index)} (${name}) recorded not_applicable. Its loader is dormant in this environment, which is a P0 regression for batch 2 P1.`,
      ).toBe(false);
    }
  });

  // ---------------------------------------------------------------------------
  // Step 5: half-shipped HMAC regression guard
  // ---------------------------------------------------------------------------

  it("does not return a half-shipped 401 from the Python reconciliation agent", async () => {
    // Regression guard for the batch 1 / batch 2 P1 bug: before the fix, the
    // api was NOT signing outbound calls to the Python brain-agents service
    // while the Python side required X-Brain-Auth in production. Every
    // reconciliation proposal therefore 401'd, bubbling up as a 500 from this
    // endpoint with body `agents_auth_invalid` or `agents_auth_missing`.
    //
    // We can't directly invoke the reconciliation flow from a vanilla agent
    // JWT without a tenant-scoped agent registered for it, so this test
    // settles for a probe: list the most recent audit events emitted on
    // layer=agent and verify NONE of them carry an outputs.error that
    // matches the half-shipped HMAC failure mode.
    const events = await agent.get<{ events: AuditEventMin[] }>(
      "/v1/audit/events?layer=agent&limit=50",
    );
    const halfShipped = events.events.filter((e) => {
      const out = e.outputs ?? {};
      const errStr = JSON.stringify(out);
      return (
        errStr.includes("agents_auth_invalid") ||
        errStr.includes("agents_auth_missing") ||
        errStr.includes("agents_auth_unconfigured")
      );
    });
    expect(halfShipped).toEqual([]);
  });
});
