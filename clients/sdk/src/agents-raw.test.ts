import { describe, expect, it, vi } from "vitest";

import { Brain } from "./brain.js";

function mockFetch(
  status: number,
  body: unknown,
): { fetch: typeof globalThis.fetch; calls: Request[] } {
  const calls: Request[] = [];
  const fn = vi.fn(async (input: Request | URL | string) => {
    calls.push(input as Request);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  return { fetch: fn as unknown as typeof globalThis.fetch, calls };
}

describe("Brain.agents", () => {
  it("list returns agents array", async () => {
    const { fetch, calls } = mockFetch(200, {
      agents: [{ id: "agent_1" }, { id: "agent_2" }],
    });
    const brain = new Brain({ apiKey: "k", fetch });

    const agents = await brain.agents.list();

    expect(agents).toHaveLength(2);
    expect(calls[0]?.url).toContain("/agents");
  });

  it("list returns empty array when body has none", async () => {
    const { fetch } = mockFetch(200, {});
    const brain = new Brain({ apiKey: "k", fetch });

    expect(await brain.agents.list()).toEqual([]);
  });

  it("get returns one agent", async () => {
    const { fetch, calls } = mockFetch(200, { id: "agent_1", kind: "internal" });
    const brain = new Brain({ apiKey: "k", fetch });

    const agent = await brain.agents.get("agent_1");

    expect(agent.id).toBe("agent_1");
    expect(calls[0]?.url).toContain("/agents/agent_1");
  });

  it("register posts the body", async () => {
    const { fetch, calls } = mockFetch(201, {
      id: "agent_new",
      state: "pending_onchain",
    });
    const brain = new Brain({ apiKey: "k", fetch });

    const agent = await brain.agents.register({
      agent_id: "agent_new",
      role: "reconciliation",
      display_name: "Recon Bot",
    });

    expect(agent.id).toBe("agent_new");
    const body = await calls[0]!.text();
    expect(body).toContain('"agent_id":"agent_new"');
    expect(body).toContain('"role":"reconciliation"');
  });

  it("listActions camelCases the response and forwards limit", async () => {
    const { fetch, calls } = mockFetch(200, {
      actions: [
        {
          proposal_id: "prop_1",
          payment_intent_id: null,
          status: "pending",
          created_at: "2026-05-19T12:00:00Z",
        },
      ],
    });
    const brain = new Brain({ apiKey: "k", fetch });

    const result = await brain.agents.listActions("agent_1", { limit: 25 });

    expect(result.actions).toEqual([
      {
        proposalId: "prop_1",
        paymentIntentId: null,
        status: "pending",
        createdAt: "2026-05-19T12:00:00Z",
      },
    ]);
    expect(calls[0]?.url).toContain("limit=25");
  });

  it("propose returns the camelCased result", async () => {
    const { fetch, calls } = mockFetch(201, {
      proposal_id: "prop_1",
      policy_decision_id: "pd_1",
      status: "pending",
    });
    const brain = new Brain({ apiKey: "k", fetch });

    const result = await brain.agents.propose("agent_1", {
      type: "categorize_transaction",
      tx_id: "tx_1",
    });

    expect(result).toEqual({
      proposalId: "prop_1",
      policyDecisionId: "pd_1",
      status: "pending",
    });
    expect(calls[0]?.url).toContain("/agents/agent_1/propose");
    const body = await calls[0]!.text();
    expect(body).toContain('"type":"categorize_transaction"');
  });
});

describe("Brain.raw", () => {
  it("ingest posts source_type + url, camelCases", async () => {
    const { fetch, calls } = mockFetch(201, {
      raw_id: "raw_1",
      sha256: "abc",
    });
    const brain = new Brain({ apiKey: "k", fetch });

    const result = await brain.raw.ingest({
      sourceType: "document" as never,
      url: "https://example.com/file.pdf",
      sourceRef: { provider: "test" },
      authHeader: "Bearer x",
    });

    expect(result.raw_id).toBe("raw_1");
    const body = await calls[0]!.text();
    expect(body).toContain('"source_type":"document"');
    expect(body).toContain('"url":"https://example.com/file.pdf"');
    expect(body).toContain('"auth_header":"Bearer x"');
    expect(body).toContain('"source_ref":{"provider":"test"}');
  });

  it("ingest omits optional fields when not provided", async () => {
    const { fetch, calls } = mockFetch(201, { raw_id: "raw_1" });
    const brain = new Brain({ apiKey: "k", fetch });

    await brain.raw.ingest({
      sourceType: "document" as never,
      url: "https://example.com/file.pdf",
    });

    const body = await calls[0]!.text();
    expect(body).not.toContain("auth_header");
    expect(body).not.toContain("source_ref");
  });

  it("get returns camelCased artifact", async () => {
    const { fetch, calls } = mockFetch(200, {
      raw_id: "raw_1",
      sha256: "abc",
      signed_url: "https://signed.example/x",
      expires_at: "2026-05-20T00:00:00Z",
      mime_type: "application/pdf",
      bytes: 1024,
    });
    const brain = new Brain({ apiKey: "k", fetch });

    const result = await brain.raw.get("raw_1");

    expect(result).toEqual({
      rawId: "raw_1",
      sha256: "abc",
      signedUrl: "https://signed.example/x",
      expiresAt: "2026-05-20T00:00:00Z",
      mimeType: "application/pdf",
      bytes: 1024,
    });
    expect(calls[0]?.url).toContain("/raw/raw_1");
  });

  it("getParsed returns parsed records and forwards parser filter", async () => {
    const { fetch, calls } = mockFetch(200, {
      raw_id: "raw_1",
      parsed: [{ parser: "pdf", parser_version: "1.0" }],
    });
    const brain = new Brain({ apiKey: "k", fetch });

    const result = await brain.raw.getParsed("raw_1", { parser: "pdf" });

    expect(result.parsed).toHaveLength(1);
    expect(result.rawId).toBe("raw_1");
    expect(calls[0]?.url).toContain("parser=pdf");
  });

  it("getParsed returns empty array when body has none", async () => {
    const { fetch } = mockFetch(200, { raw_id: "raw_1" });
    const brain = new Brain({ apiKey: "k", fetch });

    const result = await brain.raw.getParsed("raw_1");

    expect(result.parsed).toEqual([]);
  });
});
