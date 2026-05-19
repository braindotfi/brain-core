import { describe, expect, it } from "vitest";
import { Brain, type FetchLike } from "../index.js";
import { AGENT_CAPABILITIES } from "./agents.js";

interface Call {
  url: string;
  method: string;
  body?: string;
}

function makeBrain(response: unknown): { brain: Brain; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({
      url: typeof input === "string" ? input : input.toString(),
      method: init?.method ?? "GET",
      ...(init?.body !== undefined ? { body: String(init.body) } : {}),
    });
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { brain: new Brain({ apiKey: "brain_sk_test_x", fetch }), calls };
}

describe("AGENT_CAPABILITIES", () => {
  it("exports the canonical vocabulary from docs/sdk-audit.md decision C", () => {
    expect(AGENT_CAPABILITIES).toEqual([
      "ledger:read",
      "wiki:read",
      "raw:write",
      "payment_intent:propose",
      "agent:propose",
    ]);
  });
});

describe("brain.agents.register", () => {
  it("POSTs to /agents/register with snake_case wire fields", async () => {
    const { brain, calls } = makeBrain({
      id: "ag_1",
      address: "0xabc",
      identity_root: "0xroot",
    });
    await brain.agents.register({
      address: "0xabc",
      identityRoot: "0xroot",
      mcpEndpoint: "https://agent.example.com/mcp",
      capabilities: ["ledger:read", "payment_intent:propose"],
      metadataUri: "ipfs://Qm...",
    });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/agents/register");
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body.onchain_address).toBe("0xabc");
    expect(body.identity_root).toBe("0xroot");
    expect(body.mcp_endpoint).toBe("https://agent.example.com/mcp");
    expect(body.capabilities).toEqual(["ledger:read", "payment_intent:propose"]);
    expect(body.metadata_uri).toBe("ipfs://Qm...");
  });
});

describe("brain.agents.list / get", () => {
  it("list() hits GET /agents", async () => {
    const { brain, calls } = makeBrain({ agents: [] });
    await brain.agents.list({ tenantId: "acme" });
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toContain("/agents");
    expect(calls[0]?.url).toContain("tenantId=acme");
  });

  it("get() URL-encodes the agent id", async () => {
    const { brain, calls } = makeBrain({ id: "ag_1" });
    await brain.agents.get("ag_special/1");
    expect(calls[0]?.url).toContain("/agents/ag_special%2F1");
  });
});

describe("brain.agents.propose", () => {
  it("POSTs to /agents/{id}/propose with tenantId + action body", async () => {
    const { brain, calls } = makeBrain({
      actionId: "pi_1",
      decision: "ESCALATE",
      policy_version: 1,
      approvers: ["role:cfo"],
    });
    const result = await brain.agents.propose({
      tenantId: "acme",
      agentId: "ag_1",
      action: { type: "pay_invoice", amount: "1000.00" },
    });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/agents/ag_1/propose");
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body.tenantId).toBe("acme");
    expect(body.action.type).toBe("pay_invoice");
    expect(result.decision).toBe("ESCALATE");
    expect(result.approvers).toEqual(["role:cfo"]);
  });
});
