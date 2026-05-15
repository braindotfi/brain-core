import { describe, expect, it } from "vitest";
import { Brain, type FetchLike } from "../index.js";

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

describe("brain.policy.getActive", () => {
  it("hits GET /policy/{tenant_id}", async () => {
    const { brain, calls } = makeBrain({ id: "pol_1", version: 1 });
    await brain.policy.getActive({ tenantId: "acme" });
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toContain("/policy/acme");
  });
});

describe("brain.policy.listVersions", () => {
  it("hits GET /policy/{tenant_id}/versions", async () => {
    const { brain, calls } = makeBrain({ versions: [] });
    await brain.policy.listVersions({ tenantId: "acme" });
    expect(calls[0]?.url).toContain("/policy/acme/versions");
  });
});

describe("brain.policy.compose", () => {
  it("POSTs the DSL body to /policy/{tenant_id}/compose", async () => {
    const { brain, calls } = makeBrain({
      content_hash: "0xabc",
      typed_data: {},
      required_signers: ["root"],
    });
    await brain.policy.compose({
      tenantId: "acme",
      content: { rules: [] },
    });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/policy/acme/compose");
    expect(calls[0]?.body).toBe(JSON.stringify({ rules: [] }));
  });
});

describe("brain.policy.sign", () => {
  it("POSTs content_hash + signatures", async () => {
    const { brain, calls } = makeBrain({ id: "pol_1", version: 2 });
    await brain.policy.sign({
      tenantId: "acme",
      contentHash: "0xabc",
      signatures: [{ signer: "0xs1", signature: "0xsig" }],
    });
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body.content_hash).toBe("0xabc");
    expect(body.signatures).toHaveLength(1);
  });
});

describe("brain.policy.evaluate", () => {
  it("POSTs the proposed action to /policy/{tenant_id}/evaluate and forwards the docs decision vocabulary", async () => {
    // Wire decision is ALLOW | ESCALATE | DENY per
    // docs/sdk-audit.md decision overrride (see audit & PLAN-FIRST #10).
    const { brain, calls } = makeBrain({
      decision: "ALLOW",
      trace: [],
      required_approvers: [],
      policy_version: 1,
    });
    const decision = await brain.policy.evaluate({
      tenantId: "acme",
      action: { type: "outbound_payment", amount: { currency: "USD", value: 100 } },
    });
    expect(calls[0]?.url).toContain("/policy/acme/evaluate");
    expect(decision.decision).toBe("ALLOW");
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body.type).toBe("outbound_payment");
  });
});

describe("brain.policy.simulate", () => {
  it("POSTs to /policy/{tenant_id}/simulate with version and surfaces the ESCALATE decision", async () => {
    const { brain, calls } = makeBrain({ decision: "ESCALATE" });
    const result = await brain.policy.simulate({
      tenantId: "acme",
      action: { type: "outbound_payment" },
      version: 2,
    });
    expect(calls[0]?.url).toContain("/policy/acme/simulate");
    expect(result.decision).toBe("ESCALATE");
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body.version).toBe(2);
    expect(body.action.type).toBe("outbound_payment");
  });
});
