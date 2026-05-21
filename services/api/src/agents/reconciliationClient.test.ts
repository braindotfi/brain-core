import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ReconciliationAgentClient } from "./reconciliationClient.js";
import type { ServiceCallContext } from "@brain/shared";

const CTX: ServiceCallContext = {
  tenantId: "tnt_01TEST000000000000000000000",
  actor: "agent_01TEST000000000000000000",
  principalType: "agent",
  scopes: ["execution:propose"],
};

const PROPOSAL = {
  id: "prop_01TEST000000000000000000000",
  proposing_agent_id: "agent_01TEST000000000000000000",
  action: { kind: "reconciliation" },
  policy_decision_id: "dec_01TEST000000000000000000000",
  status: "pending",
  approvers_signed: [],
  created_at: "2025-01-01T00:00:00Z",
};

describe("ReconciliationAgentClient.propose", () => {
  const BASE_URL = "http://agents.internal";
  let client: ReconciliationAgentClient;

  beforeEach(() => {
    client = new ReconciliationAgentClient(BASE_URL);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns ProposalRecord on 200 response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => PROPOSAL }));
    const result = await client.propose(CTX, "agent_01TEST000000000000000000", {
      action: { kind: "reconciliation" },
    });
    expect(result).toEqual(PROPOSAL);
  });

  it("posts to /run/reconciliation with correct body", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => PROPOSAL });
    vi.stubGlobal("fetch", mockFetch);

    await client.propose(CTX, "agent_01TEST000000000000000000", {
      action: { kind: "reconciliation" },
    });

    expect(mockFetch).toHaveBeenCalledWith(`${BASE_URL}/run/reconciliation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: "agent_01TEST000000000000000000",
        action: { kind: "reconciliation" },
        tenant_id: CTX.tenantId,
      }),
    });
  });

  it("throws internal_server_error when fetch rejects (network error)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection refused")));
    await expect(
      client.propose(CTX, "agent_01TEST000000000000000000", { action: {} }),
    ).rejects.toMatchObject({ code: "internal_server_error" });
  });

  it("throws internal_server_error when response is not ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue({ ok: false, status: 503, text: async () => "service unavailable" }),
    );
    await expect(
      client.propose(CTX, "agent_01TEST000000000000000000", { action: {} }),
    ).rejects.toMatchObject({ code: "internal_server_error" });
  });
});

describe("ReconciliationAgentClient — unimplemented stubs", () => {
  let client: ReconciliationAgentClient;

  beforeEach(() => {
    client = new ReconciliationAgentClient("http://agents.internal");
  });

  it("list throws internal_server_error", async () => {
    await expect(client.list(CTX)).rejects.toMatchObject({ code: "internal_server_error" });
  });

  it("get throws internal_server_error", async () => {
    await expect(client.get(CTX, "agent_id")).rejects.toMatchObject({
      code: "internal_server_error",
    });
  });

  it("register throws internal_server_error", async () => {
    await expect(
      client.register(CTX, {
        id: "x",
        kind: "internal",
        role: "reconciliation",
        display_name: "x",
        scope_hash: null,
        onchain_address: null,
        registered_tx: null,
      }),
    ).rejects.toMatchObject({ code: "internal_server_error" });
  });

  it("listActions throws internal_server_error", async () => {
    await expect(client.listActions(CTX, "agent_id", 10)).rejects.toMatchObject({
      code: "internal_server_error",
    });
  });

  it("approve throws internal_server_error", async () => {
    await expect(client.approve(CTX, "prop_id")).rejects.toMatchObject({
      code: "internal_server_error",
    });
  });

  it("reject throws internal_server_error", async () => {
    await expect(client.reject(CTX, "prop_id")).rejects.toMatchObject({
      code: "internal_server_error",
    });
  });

  it("escalate throws internal_server_error", async () => {
    await expect(client.escalate(CTX, "prop_id")).rejects.toMatchObject({
      code: "internal_server_error",
    });
  });
});
