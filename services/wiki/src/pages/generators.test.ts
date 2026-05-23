import { describe, expect, it, vi } from "vitest";
import type { ServiceCallContext, TenantScopedClient } from "@brain/shared";
import { PolicyPageGenerator } from "./policy.js";
import { AgentPageGenerator } from "./agent.js";
import type { AgentView, PolicyReader, PolicyView, AgentReader } from "./types.js";

const ctx: ServiceCallContext = { tenantId: "tnt_test", actor: "user_test", requestId: "req_1" };

// A client that fails any query — proves the policy generator does NOT touch
// the DB and the agent generator only uses it for the sanctioned ledger read.
function noDbClient(): TenantScopedClient {
  return {
    query: vi.fn(async () => {
      throw new Error("policy/agent generators must not query the DB directly");
    }),
  } as unknown as TenantScopedClient;
}

function ledgerOnlyClient(): TenantScopedClient {
  return {
    query: vi.fn(async (text: string) => {
      if (text.includes("ledger_payment_intents")) return { rows: [], rowCount: 0 };
      throw new Error(`unexpected direct query: ${text.slice(0, 40)}`);
    }),
  } as unknown as TenantScopedClient;
}

describe("PolicyPageGenerator", () => {
  const policy: PolicyView = {
    id: "pol_1",
    version: 3,
    state: "active",
    quorum_required: 2,
    signers: [{ address: "0xabc" }],
    activated_at: new Date("2026-05-01T00:00:00Z"),
    deactivated_at: null,
    created_by: "user_root",
    created_at: new Date("2026-04-01T00:00:00Z"),
  };

  it("renders an active policy from the policy reader (no direct DB)", async () => {
    const reader: PolicyReader = { byId: async () => null, active: async () => policy };
    const gen = new PolicyPageGenerator();
    const out = await gen.render(
      { ctx, client: noDbClient(), policyReader: reader },
      { subjectId: null, slug: "/policies/active" },
    );
    expect(out.body_md).toContain("Policy v3");
    expect(out.body_md).toContain("active");
    expect(out.subject_id).toBe("pol_1");
  });

  it("renders the no-policy page when the reader returns null", async () => {
    const reader: PolicyReader = { byId: async () => null, active: async () => null };
    const gen = new PolicyPageGenerator();
    const out = await gen.render(
      { ctx, client: noDbClient(), policyReader: reader },
      { subjectId: null, slug: "/policies/active" },
    );
    expect(out.body_md).toContain("No active policy");
  });
});

describe("AgentPageGenerator", () => {
  const agent: AgentView = {
    id: "agent_1",
    kind: "treasury",
    role: "payer",
    display_name: "Treasury Bot",
    onchain_address: "0xdef",
    state: "active",
    registered_at: new Date("2026-05-01T00:00:00Z"),
    created_at: new Date("2026-04-01T00:00:00Z"),
  };

  it("renders an agent from the agent reader; payment intents via the sanctioned ledger read", async () => {
    const reader: AgentReader = { byId: async () => agent };
    const gen = new AgentPageGenerator();
    const out = await gen.render(
      { ctx, client: ledgerOnlyClient(), agentReader: reader },
      { subjectId: "agent_1", slug: "/agents/agent_1" },
    );
    expect(out.body_md).toContain("Treasury Bot");
    expect(out.subject_id).toBe("agent_1");
  });
});
