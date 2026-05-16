/**
 * Proof test 3 (§6 of Brain_MVP_Architecture.md):
 *
 * "An external agent connects via MCP, reads the Wiki, proposes an action,
 * gets gated by Policy, executed through the tenant's rails, and logged
 * in Audit, no different from an internal Brain agent."
 *
 * Runs against staging with a pre-registered external agent whose JWT is
 * supplied via BRAIN_EXTERNAL_AGENT_TOKEN.
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
    const res = await agent.post<{ ok: boolean }>("/execution/mcp", { method: "ping" });
    expect(res.ok).toBe(true);
  });

  it("agent reads wiki with wiki:read scope", async () => {
    const search = await agent.get<{ results: unknown[] }>(
      "/wiki/search?kind=counterparty&limit=5",
    );
    expect(Array.isArray(search.results)).toBe(true);
  });

  it("agent proposes an action which is gated by policy and audited", async () => {
    const proposal = await agent.post<{ id: string; policy_decision: string }>(
      "/execution/propose",
      {
        action: {
          kind: "outbound_payment",
          counterparty_id: process.env.BRAIN_TEST_VENDOR_ID ?? "cp_aws",
          amount: { currency: "USD", value: "10.00" },
          agent_role: "partner",
          timestamp: new Date().toISOString(),
        },
      },
    );
    expect(proposal.id.startsWith("prop_")).toBe(true);
    // Decision can be any of allow/confirm/reject — the test's point is
    // that the agent got through the same policy gate an internal agent
    // would.
    expect(["allow", "confirm", "reject"]).toContain(proposal.policy_decision);

    // Audit emitted — the proposal id appears in recent audit events.
    const events = await agent.get<{ events: Array<{ outputs: { proposal_id?: string } }> }>(
      "/audit/events?layer=execution&limit=20",
    );
    const match = events.events.find((e) => e.outputs?.proposal_id === proposal.id);
    expect(match).toBeDefined();
  });
});
