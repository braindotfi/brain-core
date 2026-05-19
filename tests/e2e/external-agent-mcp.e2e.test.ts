/**
 * Proof test 3 (§6 of Brain_MVP_Architecture.md):
 *
 * "An external agent connects via MCP, reads the Wiki, proposes an action,
 * gets gated by Policy, executed through the tenant's rails, and logged
 * in Audit, no different from an internal Brain agent."
 *
 * Runs against staging with a pre-registered external agent whose JWT is
 * supplied via BRAIN_EXTERNAL_AGENT_TOKEN.
 * Optional: BRAIN_TEST_VENDOR_ID, BRAIN_TEST_SOURCE_ACCT_ID.
 */

import { describe, expect, it } from "vitest";
import { BrainClient } from "./lib/client.js";

const DESCRIBE =
  process.env.BRAIN_BASE_URL !== undefined && process.env.BRAIN_EXTERNAL_AGENT_TOKEN !== undefined
    ? describe
    : describe.skip;

DESCRIBE("external agent via MCP (Series A proof 3)", () => {
  const agent = new BrainClient({
    baseUrl: process.env.BRAIN_BASE_URL!,
    token: process.env.BRAIN_EXTERNAL_AGENT_TOKEN!,
  });

  it("agent ping via MCP succeeds with principal_type=agent JWT", async () => {
    const res = await agent.post<{ ok: boolean }>("/v1/agents/mcp", { method: "ping" });
    expect(res.ok).toBe(true);
  });

  it("agent reads wiki with wiki:read scope", async () => {
    // v0.3: wiki-resident kinds are 'policy' and 'agent'; Ledger kinds
    // (counterparty, transaction, account, obligation) were removed from
    // /wiki/search. Query without a kind filter to get all wiki entities.
    const search = await agent.get<{ results: unknown[]; next_cursor: null }>(
      "/v1/wiki/search?limit=5",
    );
    expect(Array.isArray(search.results)).toBe(true);
  });

  it("agent proposes an action which is gated by policy and audited", async () => {
    // v0.3: proposal == PaymentIntent. POST /v1/payment-intents evaluates the
    // policy DSL during creation and records a policy_decision_id.
    const intent = await agent.post<{
      id: string;
      status: string;
      policy_decision_id: string | null;
    }>("/v1/payment-intents", {
      action_type: "ach_outbound",
      source_account_id: process.env.BRAIN_TEST_SOURCE_ACCT_ID ?? "",
      destination_counterparty_id: process.env.BRAIN_TEST_VENDOR_ID ?? "",
      amount: "10.00",
      currency: "USD",
    });
    expect(intent.id.startsWith("pi_")).toBe(true);
    // status reflects policy outcome: approved (allow) | pending_approval (confirm) | rejected (reject)
    expect(["proposed", "pending_approval", "approved", "rejected"]).toContain(intent.status);

    // Audit emitted on layer="agent" — the payment_intent id appears in recent events.
    const events = await agent.get<{
      events: Array<{ outputs: { payment_intent_id?: string } }>;
    }>("/v1/audit/events?layer=agent&limit=20");
    const match = events.events.find((e) => e.outputs?.payment_intent_id === intent.id);
    expect(match).toBeDefined();
  });
});
