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
    const brain = new Brain({ token: "k", fetch });

    const agents = await brain.agents.list();

    expect(agents).toHaveLength(2);
    expect(calls[0]?.url).toContain("/agents");
  });

  it("list returns empty array when body has none", async () => {
    const { fetch } = mockFetch(200, {});
    const brain = new Brain({ token: "k", fetch });

    expect(await brain.agents.list()).toEqual([]);
  });

  it("get returns one agent", async () => {
    const { fetch, calls } = mockFetch(200, { id: "agent_1", kind: "internal" });
    const brain = new Brain({ token: "k", fetch });

    const agent = await brain.agents.get("agent_1");

    expect(agent.id).toBe("agent_1");
    expect(calls[0]?.url).toContain("/agents/agent_1");
  });

  it("register posts the body", async () => {
    const { fetch, calls } = mockFetch(201, {
      id: "agent_new",
      state: "pending_onchain",
    });
    const brain = new Brain({ token: "k", fetch });

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
    const brain = new Brain({ token: "k", fetch });

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
    const brain = new Brain({ token: "k", fetch });

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

  it("restore posts a truly empty body to the restore route", async () => {
    const { fetch, calls } = mockFetch(200, { agent_id: "agent_1", restored: true });
    const brain = new Brain({ token: "k", fetch });

    const result = await brain.agents.restore("agent_1");

    expect(result).toEqual({ agent_id: "agent_1", restored: true });
    expect(calls[0]?.url).toContain("/agents/agent_1/restore");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers.get("content-type")).toBeNull();
    expect(await calls[0]!.text()).toBe("");
  });

  it("releaseContributionHold posts a truly empty body", async () => {
    const { fetch, calls } = mockFetch(200, {
      agent_id: "agent_1",
      contribution_hold_released: true,
    });
    const brain = new Brain({ token: "k", fetch });

    const result = await brain.agents.releaseContributionHold("agent_1");

    expect(result).toEqual({ agent_id: "agent_1", contribution_hold_released: true });
    expect(calls[0]?.url).toContain("/agents/agent_1/contribution-hold/release");
    expect(calls[0]?.headers.get("content-type")).toBeNull();
    expect(await calls[0]!.text()).toBe("");
  });
});

describe("Brain.raw", () => {
  it("ingest posts source_type + url, camelCases", async () => {
    const { fetch, calls } = mockFetch(201, {
      raw_id: "raw_1",
      sha256: "abc",
    });
    const brain = new Brain({ token: "k", fetch });

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
    const brain = new Brain({ token: "k", fetch });

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
    const brain = new Brain({ token: "k", fetch });

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
    const brain = new Brain({ token: "k", fetch });

    const result = await brain.raw.getParsed("raw_1", { parser: "pdf" });

    expect(result.parsed).toHaveLength(1);
    expect(result.rawId).toBe("raw_1");
    expect(calls[0]?.url).toContain("parser=pdf");
  });

  it("getParsed returns empty array when body has none", async () => {
    const { fetch } = mockFetch(200, { raw_id: "raw_1" });
    const brain = new Brain({ token: "k", fetch });

    const result = await brain.raw.getParsed("raw_1");

    expect(result.parsed).toEqual([]);
  });

  it("extract triggers document extraction and camelCases the result", async () => {
    const { fetch, calls } = mockFetch(200, {
      job_id: "rxj_1",
      raw_id: "raw_1",
      status: "queued",
      parsed_id: "prs_1",
      confidence: 0.93,
      error: null,
      next_attempt_at: null,
      created_at: "2026-07-20T00:00:00Z",
      updated_at: "2026-07-20T00:00:01Z",
    });
    const brain = new Brain({ token: "k", fetch });

    const result = await brain.raw.extract("raw_1");

    expect(result).toMatchObject({ jobId: "rxj_1", parsedId: "prs_1", confidence: 0.93 });
    expect(calls[0]?.url).toContain("/raw/raw_1/extract");
    expect(calls[0]?.method).toBe("POST");
  });

  it("polls source sync job status and camelCases the result", async () => {
    const { fetch, calls } = mockFetch(200, {
      job_id: "sjob_1",
      source_id: "src_1",
      status: "enqueued",
      error_message: null,
      created_at: "2026-07-20T00:00:00Z",
      updated_at: "2026-07-20T00:00:01Z",
    });
    const brain = new Brain({ token: "k", fetch });

    const result = await brain.raw.getSourceSyncJob("src_1", "sjob_1");

    expect(result).toEqual({
      jobId: "sjob_1",
      sourceId: "src_1",
      status: "enqueued",
      errorMessage: null,
      notes: undefined,
      createdAt: "2026-07-20T00:00:00Z",
      updatedAt: "2026-07-20T00:00:01Z",
    });
    expect(calls[0]?.url).toContain("/sources/src_1/sync/sjob_1");
    expect(calls[0]?.method).toBe("GET");
  });

  it("lists sources with cursor metadata", async () => {
    const { fetch, calls } = mockFetch(200, {
      data: [{ id: "src_1", type: "plaid", status: "active" }],
      next_cursor: "src_cursor",
    });
    const brain = new Brain({ token: "k", fetch });

    const page = await brain.raw.listSources({ limit: 1, cursor: "old" });

    expect(page.sources).toHaveLength(1);
    expect(page.nextCursor).toBe("src_cursor");
    expect(calls[0]?.url).toContain("/sources?limit=1");
    expect(calls[0]?.url).toContain("cursor=old");
  });

  it("deleteArtifact sends DELETE with a truly empty body and resolves on 204", async () => {
    const calls: Request[] = [];
    const fetch = vi.fn(async (input: Request | URL | string) => {
      calls.push(input as Request);
      return new Response(null, { status: 204 });
    });
    const brain = new Brain({ token: "k", fetch: fetch as unknown as typeof globalThis.fetch });

    await expect(brain.raw.deleteArtifact("raw_1")).resolves.toBeUndefined();
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toContain("/raw/raw_1");
    expect(calls[0]?.headers.get("content-type")).toBeNull();
    expect(await calls[0]!.text()).toBe("");
  });

  it("deleteArtifact surfaces a scope-insufficient 403 as BrainAPIError (no principal has raw:admin yet)", async () => {
    const { fetch } = mockFetch(403, {
      error: {
        code: "auth_scope_insufficient",
        message: "missing required scope: raw:admin",
        request_id: "req_1",
        docs_url: "https://docs.brain.fi/resources/errors#auth_scope_insufficient",
      },
    });
    const brain = new Brain({ token: "k", fetch });

    await expect(brain.raw.deleteArtifact("raw_1")).rejects.toMatchObject({ status: 403 });
  });

  it("writeParsed posts parser/parser_version/extracted and returns the parsed row", async () => {
    const { fetch, calls } = mockFetch(201, {
      id: "rp_1",
      raw_id: "raw_1",
      parser: "pdf_text",
      parser_version: "1.0.0",
    });
    const brain = new Brain({ token: "k", fetch });

    const result = await brain.raw.writeParsed("raw_1", {
      parser: "pdf_text",
      parser_version: "1.0.0",
      extracted: { total: "42.00" },
    });

    expect(result.id).toBe("rp_1");
    expect(calls[0]?.url).toContain("/raw/raw_1/parsed");
    const sent = await calls[0]!.text();
    expect(sent).toContain('"parser":"pdf_text"');
  });

  it("connectSource posts type/credentials and returns the created source", async () => {
    const { fetch, calls } = mockFetch(201, { id: "src_1", type: "plaid", status: "active" });
    const brain = new Brain({ token: "k", fetch });

    const source = await brain.raw.connectSource({
      type: "plaid",
      credentials: { access_token: "sandbox-token" },
    });

    expect(source.id).toBe("src_1");
    expect(calls[0]?.url).toContain("/sources");
    const sent = await calls[0]!.text();
    expect(sent).toContain('"access_token":"sandbox-token"');
  });

  it("getSource fetches one source by id", async () => {
    const { fetch, calls } = mockFetch(200, { id: "src_1", type: "plaid" });
    const brain = new Brain({ token: "k", fetch });

    await brain.raw.getSource("src_1");

    expect(calls[0]?.url).toContain("/sources/src_1");
  });

  it("disconnectSource sends DELETE with a truly empty body and returns the disconnected source", async () => {
    const { fetch, calls } = mockFetch(200, { id: "src_1", status: "disconnected" });
    const brain = new Brain({ token: "k", fetch });

    const source = await brain.raw.disconnectSource("src_1");

    expect(source.status).toBe("disconnected");
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.headers.get("content-type")).toBeNull();
    const sent = await calls[0]!.text();
    expect(sent).toBe("");
  });
});
