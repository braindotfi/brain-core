import { describe, expect, it, vi } from "vitest";
import { InMemoryAuditEmitter, type Principal } from "@brain/api/shared";
import { BrainMcpServer } from "./server.js";
import { FakeAuthVerifier, type AgentRecord } from "./auth.js";
import type {
  ILedgerService,
  IPaymentIntentService,
  IRawEvidenceService,
  IWikiMemoryService,
} from "@brain/api/shared";

const TENANT = "tnt_test";
const AGENT_ID = "agent_payment01";

const ACTIVE_AGENT: AgentRecord = {
  id: AGENT_ID,
  tenant_id: TENANT,
  state: "active",
  scope_hash: null,
  onchain_address: null,
  role: "payment",
};

function principal(scopes: string[]): Principal {
  return {
    id: AGENT_ID,
    type: "agent",
    tenantId: TENANT,
    scopes: scopes as unknown as Principal["scopes"],
    tokenId: "token_test",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

function fakeLedger(): ILedgerService {
  return {
    listAccounts: vi.fn(async () => ({ items: [], next_cursor: null })),
    getAccount: vi.fn(async () => null),
    listTransactions: vi.fn(async () => ({ items: [], next_cursor: null })),
    getTransaction: vi.fn(async () => null),
    listCounterparties: vi.fn(async () => ({ items: [], next_cursor: null })),
    listObligations: vi.fn(async () => ({ items: [], next_cursor: null })),
    listInvoices: vi.fn(async () => ({ items: [], next_cursor: null })),
    listDocuments: vi.fn(async () => ({ items: [], next_cursor: null })),
    listBalances: vi.fn(async () => []),
    upsertAccount: vi.fn(),
    recordTransaction: vi.fn(),
    upsertCounterparty: vi.fn(),
    normalizeFromRaw: vi.fn(async () => ({ created: [] })),
  } as unknown as ILedgerService;
}

function fakeWiki(answer = "OK"): IWikiMemoryService {
  return {
    listPages: vi.fn(async () => ({ pages: [] })),
    getPage: vi.fn(async () => null),
    regenerate: vi.fn(),
    search: vi.fn(async () => []),
    question: vi.fn(async (_ctx, req) => ({
      question: req.question,
      answer,
      evidence: [],
      model: "test-model",
      usage: { inputTokens: 1, outputTokens: 1 },
    })),
    annotate: vi.fn(),
  } as unknown as IWikiMemoryService;
}

function fakeRaw(): IRawEvidenceService {
  return {
    ingest: vi.fn(async () => ({
      rawId: "raw_TEST",
      sha256: "deadbeef",
      bytes: 5,
      sourceType: "agent_contributed",
      ingestedAt: new Date().toISOString(),
      deduplicated: false,
    })),
    signedUrl: vi.fn(),
    listParsed: vi.fn(async () => []),
    tombstone: vi.fn(),
  } as unknown as IRawEvidenceService;
}

function fakePI(): IPaymentIntentService {
  return {
    create: vi.fn(async (_ctx, input) => ({
      id: "pi_TEST",
      owner_id: TENANT,
      source_ids: [],
      evidence_ids: input.evidence_ids ?? [],
      provenance: "inferred" as const,
      confidence: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      created_by_agent_id: input.agent_id ?? null,
      action_type: input.action_type,
      source_account_id: input.source_account_id,
      destination_counterparty_id: input.destination_counterparty_id,
      amount: input.amount,
      currency: input.currency,
      obligation_id: input.obligation_id ?? null,
      invoice_id: input.invoice_id ?? null,
      status: "approved" as const,
      policy_decision_id: "pd_TEST",
      approval_ids: [],
      execution_receipt_ids: [],
    })),
    get: vi.fn(async () => null),
    list: vi.fn(async () => []),
    approve: vi.fn(),
    reject: vi.fn(),
    cancel: vi.fn(),
    execute: vi.fn(),
  } as unknown as IPaymentIntentService;
}

function makeServer(scopes: string[] = ["ledger:read", "wiki:read"]) {
  const audit = new InMemoryAuditEmitter();
  const server = new BrainMcpServer({
    auth: new FakeAuthVerifier(ACTIVE_AGENT),
    ledger: fakeLedger(),
    wiki: fakeWiki(),
    raw: fakeRaw(),
    paymentIntents: fakePI(),
    audit,
  });
  return { server, audit, p: principal(scopes) };
}

describe("BrainMcpServer.handle — protocol surface", () => {
  it("initialize returns protocolVersion + capabilities", async () => {
    const { server, p } = makeServer();
    const res = await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, p);
    expect("result" in res).toBe(true);
    if ("result" in res) {
      const r = res.result as { protocolVersion: string; capabilities: unknown };
      expect(typeof r.protocolVersion).toBe("string");
      expect(r.capabilities).toBeDefined();
    }
  });

  it("ping returns {}", async () => {
    const { server, p } = makeServer();
    const res = await server.handle({ jsonrpc: "2.0", id: 1, method: "ping" }, p);
    expect("result" in res && res.result).toEqual({});
  });

  it("tools/list lists every registered tool regardless of scope", async () => {
    const { server, p } = makeServer([]); // no scopes
    const res = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }, p);
    if (!("result" in res)) throw new Error("expected result");
    const r = res.result as { tools: Array<{ name: string }> };
    expect(r.tools.length).toBe(10);
    expect(r.tools.map((t) => t.name)).toContain("ledger.account.get");
    expect(r.tools.map((t) => t.name)).toContain("payment_intent.propose");
  });

  it("tools/call rejects when the agent lacks the required scope", async () => {
    const { server, p } = makeServer(["wiki:read"]); // missing ledger:read
    const res = await server.handle(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "ledger.account.get", arguments: { account_id: "acct_x" } },
      },
      p,
    );
    expect("error" in res && res.error.code).toBe(-32002);
  });

  it("tools/call dispatches to a known tool with valid input", async () => {
    const { server, audit, p } = makeServer(["wiki:read"]);
    const res = await server.handle(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "wiki.question", arguments: { question: "what's my balance" } },
      },
      p,
    );
    expect("result" in res).toBe(true);
    if ("result" in res) {
      const r = res.result as { content: Array<{ text: string }>; structuredContent?: unknown };
      expect(r.content[0]!.text).toContain("**Q:**");
    }
    // The outer audit event was emitted.
    expect(audit.events.some((e) => e.action === "agent.mcp.tool_called")).toBe(true);
  });

  it("tools/call returns method-level error on unknown tool", async () => {
    const { server, p } = makeServer(["ledger:read"]);
    const res = await server.handle(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "ledger.banana.list", arguments: {} },
      },
      p,
    );
    expect("error" in res).toBe(true);
  });

  it("tools/call returns invalid-params on missing required input", async () => {
    const { server, p } = makeServer(["ledger:read"]);
    const res = await server.handle(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "ledger.account.get", arguments: {} },
      },
      p,
    );
    expect("error" in res && res.error.code).toBe(-32602);
  });

  it("rejects non-agent principals up front", async () => {
    const { server } = makeServer();
    const userPrincipal: Principal = {
      id: "user_X",
      type: "user",
      tenantId: TENANT,
      scopes: ["wiki:read"] as unknown as Principal["scopes"],
      tokenId: "t",
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    };
    await expect(
      server.handle({ jsonrpc: "2.0", id: 1, method: "ping" }, userPrincipal),
    ).rejects.toMatchObject({ code: "auth_scope_insufficient" });
  });
});

describe("BrainMcpServer.handle — resources + prompts", () => {
  it("resources/list returns the v0.3 surface", async () => {
    const { server, p } = makeServer();
    const res = await server.handle({ jsonrpc: "2.0", id: 1, method: "resources/list" }, p);
    if (!("result" in res)) throw new Error("expected result");
    const r = res.result as { resources: Array<{ uri: string }> };
    expect(r.resources.length).toBeGreaterThan(0);
    expect(r.resources[0]!.uri.startsWith("brain://")).toBe(true);
  });

  it("prompts/list returns templated questions", async () => {
    const { server, p } = makeServer();
    const res = await server.handle({ jsonrpc: "2.0", id: 1, method: "prompts/list" }, p);
    if (!("result" in res)) throw new Error("expected result");
    const r = res.result as { prompts: Array<{ name: string }> };
    expect(r.prompts.map((x) => x.name)).toContain("wiki.question.cash_flow_summary");
  });

  it("prompts/get rejects missing required arg", async () => {
    const { server, p } = makeServer();
    const res = await server.handle(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "prompts/get",
        params: { name: "wiki.question.cash_flow_summary", arguments: {} },
      },
      p,
    );
    expect("error" in res && res.error.code).toBe(-32602);
  });

  it("prompts/get renders when args are valid", async () => {
    const { server, p } = makeServer();
    const res = await server.handle(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "prompts/get",
        params: {
          name: "wiki.question.cash_flow_summary",
          arguments: { period: "2026-04" },
        },
      },
      p,
    );
    expect("result" in res).toBe(true);
    if ("result" in res) {
      const r = res.result as { messages: Array<{ content: { text: string } }> };
      expect(r.messages[0]!.content.text).toContain("2026-04");
    }
  });
});

describe("BrainMcpServer.handle — payment_intent.propose scope gate", () => {
  it("blocks when payment_intent:propose is missing", async () => {
    const { server, p } = makeServer(["wiki:read"]);
    const res = await server.handle(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "payment_intent.propose",
          arguments: {
            action_type: "ach_outbound",
            source_account_id: "acct_x",
            destination_counterparty_id: "cp_y",
            amount: "10.00",
            currency: "USD",
          },
        },
      },
      p,
    );
    expect("error" in res && res.error.code).toBe(-32002);
  });

  it("calls PaymentIntentService.create when scope is held", async () => {
    const { server, audit, p } = makeServer(["payment_intent:propose"]);
    const res = await server.handle(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "payment_intent.propose",
          arguments: {
            action_type: "ach_outbound",
            source_account_id: "acct_x",
            destination_counterparty_id: "cp_y",
            amount: "10.00",
            currency: "USD",
          },
        },
      },
      p,
    );
    expect("result" in res).toBe(true);
    if ("result" in res) {
      const r = res.result as { content: Array<{ text: string }> };
      expect(r.content[0]!.text).toContain("PaymentIntent `pi_TEST`");
    }
    expect(audit.events.some((e) => e.action === "agent.mcp.tool_called")).toBe(true);
  });
});
