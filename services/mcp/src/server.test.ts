import { describe, expect, it, vi } from "vitest";
import {
  brainError,
  InMemoryAuditEmitter,
  type Principal,
  type ServiceCallContext,
} from "@brain/shared";
import { BrainMcpServer } from "./server.js";
import { FakeAuthVerifier, type AgentRecord, type AuthVerifier } from "./auth.js";
import type {
  ILedgerService,
  IPaymentIntentService,
  IRawEvidenceService,
  IWikiMemoryService,
} from "@brain/shared";

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
    expect(r.tools.length).toBe(12);
    const names = r.tools.map((t) => t.name);
    expect(names).toContain("ledger.account.get");
    expect(names).toContain("payment_intent.propose");
    expect(names).toContain("payment_intent.cancel");
    expect(names).toContain("payment_intent.list");
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

  it("accepts user principals via FakeAuthVerifier (dev-bypass mode)", async () => {
    // The principal_type=agent check lives in registerMcpRoute (HTTP transport),
    // not in BrainMcpServer.handle. FakeAuthVerifier is a dev/test seam that
    // skips the agents-table lookup and accepts any principal type, matching the
    // BRAIN_MCP_DEV_AUTH_BYPASS=true runtime behaviour.
    const { server } = makeServer();
    const userPrincipal: Principal = {
      id: "user_X",
      type: "user",
      tenantId: TENANT,
      scopes: ["wiki:read"] as unknown as Principal["scopes"],
      tokenId: "t",
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    };
    const res = await server.handle({ jsonrpc: "2.0", id: 1, method: "ping" }, userPrincipal);
    expect("result" in res).toBe(true);
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

describe("BrainMcpServer.handle — payment_intent.propose on-chain settlement (item 14)", () => {
  function serverWithCapture(scopes: string[]) {
    const created: Array<Record<string, unknown>> = [];
    const base = fakePI();
    const pi = {
      ...base,
      create: vi.fn(async (_ctx: unknown, input: Record<string, unknown>) => {
        created.push(input);
        return {
          id: "pi_TEST",
          owner_id: TENANT,
          source_ids: [],
          evidence_ids: [],
          provenance: "inferred" as const,
          confidence: 1,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          created_by_agent_id: null,
          action_type: input.action_type,
          source_account_id: input.source_account_id,
          destination_counterparty_id: input.destination_counterparty_id,
          amount: input.amount,
          currency: input.currency,
          obligation_id: null,
          invoice_id: null,
          status: "approved" as const,
          policy_decision_id: "pd_TEST",
          approval_ids: [],
          execution_receipt_ids: [],
        };
      }),
    } as unknown as IPaymentIntentService;
    const server = new BrainMcpServer({
      auth: new FakeAuthVerifier(ACTIVE_AGENT),
      ledger: fakeLedger(),
      wiki: fakeWiki(),
      raw: fakeRaw(),
      paymentIntents: pi,
      audit: new InMemoryAuditEmitter(),
    });
    return { server, created, p: principal(scopes) };
  }

  function propose(args: Record<string, unknown>) {
    return {
      jsonrpc: "2.0" as const,
      id: 1,
      method: "tools/call",
      params: { name: "payment_intent.propose", arguments: args },
    };
  }

  const baseArgs = {
    source_account_id: "acct_x",
    destination_counterparty_id: "cp_y",
    amount: "5.00",
    currency: "USDC",
  };

  it("accepts x402_settle with pay_to and forwards it to create", async () => {
    const { server, created, p } = serverWithCapture(["payment_intent:propose"]);
    const payTo = "0x" + "ab".repeat(20);
    const res = await server.handle(
      propose({ ...baseArgs, action_type: "x402_settle", pay_to: payTo }),
      p,
    );
    expect("result" in res).toBe(true);
    expect(created).toHaveLength(1);
    expect(created[0]!.action_type).toBe("x402_settle");
    expect(created[0]!.pay_to).toBe(payTo);
  });

  it("rejects x402_settle without pay_to", async () => {
    const { server, p } = serverWithCapture(["payment_intent:propose"]);
    const res = await server.handle(propose({ ...baseArgs, action_type: "x402_settle" }), p);
    expect("error" in res && res.error.code).toBe(-32602);
  });

  it("rejects on-chain settlement in a non-USDC currency", async () => {
    const { server, p } = serverWithCapture(["payment_intent:propose"]);
    const res = await server.handle(
      propose({
        ...baseArgs,
        currency: "USD",
        action_type: "x402_settle",
        pay_to: "0x" + "ab".repeat(20),
      }),
      p,
    );
    expect("error" in res && res.error.code).toBe(-32602);
  });

  it("accepts escrow_release with escrow_id + job_terms_hash", async () => {
    const { server, created, p } = serverWithCapture(["payment_intent:propose"]);
    const escrowId = "0x" + "11".repeat(32);
    const jobTermsHash = "0x" + "22".repeat(32);
    const res = await server.handle(
      propose({
        ...baseArgs,
        action_type: "escrow_release",
        escrow_id: escrowId,
        job_terms_hash: jobTermsHash,
      }),
      p,
    );
    expect("result" in res).toBe(true);
    expect(created[0]!.escrow_id).toBe(escrowId);
    expect(created[0]!.job_terms_hash).toBe(jobTermsHash);
  });

  it("serves the action_type catalog resource", async () => {
    const { server, p } = serverWithCapture(["payment_intent:propose"]);
    const res = await server.handle(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "resources/read",
        params: { uri: "brain://payments/action_types" },
      },
      p,
    );
    expect("result" in res).toBe(true);
    if ("result" in res) {
      const r = res.result as { contents: Array<{ text: string }> };
      const body = JSON.parse(r.contents[0]!.text) as {
        action_types: Array<{ action_type: string }>;
      };
      const names = body.action_types.map((a) => a.action_type);
      expect(names).toContain("x402_settle");
      expect(names).toContain("escrow_release");
    }
  });
});

describe("BrainMcpServer.handle — payment_intent.cancel + .list (item 17)", () => {
  function makePI(overrides: Partial<IPaymentIntentService>): IPaymentIntentService {
    return { ...fakePI(), ...overrides } as unknown as IPaymentIntentService;
  }

  function serverWithPI(pi: IPaymentIntentService, scopes: string[]) {
    const server = new BrainMcpServer({
      auth: new FakeAuthVerifier(ACTIVE_AGENT),
      ledger: fakeLedger(),
      wiki: fakeWiki(),
      raw: fakeRaw(),
      paymentIntents: pi,
      audit: new InMemoryAuditEmitter(),
    });
    return { server, p: principal(scopes) };
  }

  function ownIntent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: "pi_OWN",
      owner_id: TENANT,
      created_by_agent_id: AGENT_ID,
      action_type: "ach_outbound",
      source_account_id: "acct_x",
      destination_counterparty_id: "cp_y",
      amount: "10.00",
      currency: "USD",
      obligation_id: null,
      invoice_id: null,
      status: "proposed",
      policy_decision_id: "pd_TEST",
      approval_ids: [],
      execution_receipt_ids: [],
      evidence_ids: [],
      provenance: "inferred",
      confidence: 1,
      source_ids: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...overrides,
    };
  }

  // --- cancel ---

  it("cancel happy path — own intent in `proposed` calls service.cancel", async () => {
    const cancel = vi.fn(async () =>
      ownIntent({ status: "cancelled" }),
    ) as unknown as IPaymentIntentService["cancel"];
    const pi = makePI({
      get: vi.fn(async () => ownIntent() as never),
      cancel,
    });
    const { server, p } = serverWithPI(pi, ["payment_intent:propose"]);
    const res = await server.handle(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "payment_intent.cancel", arguments: { intent_id: "pi_OWN" } },
      },
      p,
    );
    expect("result" in res).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancel rejects when the intent belongs to a different agent", async () => {
    const cancel = vi.fn() as unknown as IPaymentIntentService["cancel"];
    const pi = makePI({
      get: vi.fn(async () => ownIntent({ created_by_agent_id: "agent_other" }) as never),
      cancel,
    });
    const { server, p } = serverWithPI(pi, ["payment_intent:propose"]);
    const res = await server.handle(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "payment_intent.cancel", arguments: { intent_id: "pi_OTHER" } },
      },
      p,
    );
    expect("error" in res).toBe(true);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("cancel rejects from non-cancellable states (e.g. executed)", async () => {
    const cancel = vi.fn() as unknown as IPaymentIntentService["cancel"];
    const pi = makePI({
      get: vi.fn(async () => ownIntent({ status: "executed" }) as never),
      cancel,
    });
    const { server, p } = serverWithPI(pi, ["payment_intent:propose"]);
    const res = await server.handle(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "payment_intent.cancel", arguments: { intent_id: "pi_OWN" } },
      },
      p,
    );
    expect("error" in res).toBe(true);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("cancel returns not-found when the intent does not exist for this tenant", async () => {
    const pi = makePI({
      get: vi.fn(async () => null),
      cancel: vi.fn() as unknown as IPaymentIntentService["cancel"],
    });
    const { server, p } = serverWithPI(pi, ["payment_intent:propose"]);
    const res = await server.handle(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "payment_intent.cancel", arguments: { intent_id: "pi_ABSENT" } },
      },
      p,
    );
    expect("error" in res).toBe(true);
  });

  it("cancel blocks when payment_intent:propose scope is missing", async () => {
    const pi = fakePI();
    const { server, p } = serverWithPI(pi, ["ledger:read"]);
    const res = await server.handle(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "payment_intent.cancel", arguments: { intent_id: "pi_OWN" } },
      },
      p,
    );
    expect("error" in res && res.error.code).toBe(-32002);
  });

  // --- list ---

  it("list forces agent_id = caller and forwards the status filter", async () => {
    const list = vi.fn(async () => [ownIntent()]) as unknown as IPaymentIntentService["list"];
    const pi = makePI({ list });
    const { server, p } = serverWithPI(pi, ["ledger:read"]);
    const res = await server.handle(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "payment_intent.list",
          arguments: { status: "proposed", limit: 5 },
        },
      },
      p,
    );
    expect("result" in res).toBe(true);
    expect(list).toHaveBeenCalledOnce();
    const [, opts] = (list as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(opts).toMatchObject({ agent_id: AGENT_ID, status: "proposed", limit: 5 });
  });

  it("list blocks when ledger:read scope is missing", async () => {
    const pi = fakePI();
    const { server, p } = serverWithPI(pi, []);
    const res = await server.handle(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "payment_intent.list", arguments: {} },
      },
      p,
    );
    expect("error" in res && res.error.code).toBe(-32002);
  });
});

describe("BrainMcpServer.handle — brain://proofs/{action_id} resource (item 17)", () => {
  function serverWithProof(
    buildProof: ((tenantId: string, actionId: string) => Promise<unknown>) | undefined,
    scopes: string[],
  ) {
    const deps: ConstructorParameters<typeof BrainMcpServer>[0] = {
      auth: new FakeAuthVerifier(ACTIVE_AGENT),
      ledger: fakeLedger(),
      wiki: fakeWiki(),
      raw: fakeRaw(),
      paymentIntents: fakePI(),
      audit: new InMemoryAuditEmitter(),
    };
    if (buildProof !== undefined) {
      deps.buildProof = buildProof as NonNullable<
        ConstructorParameters<typeof BrainMcpServer>[0]["buildProof"]
      >;
    }
    const server = new BrainMcpServer(deps);
    return { server, p: principal(scopes) };
  }

  it("returns the canonical Proof JSON for a known action", async () => {
    const proof = {
      action_id: "act_X",
      tenant_id: TENANT,
      agent_id: AGENT_ID,
      behavior_hash: null,
      outcome: "executed",
      policy_version: "v1",
      policy_hash: "0xabc",
      matched_rule_id: "r1",
      gate_checks: [{ index: 1, name: "agent_identity_verified", passed: true }],
      evidence: [],
      ledger_snapshot_hash: "0xledger",
      audit_events: [],
      merkle_root: "0xroot",
      merkle_proof: [],
      chain_anchor: null,
      rail_receipt: null,
      human_explanation: "human-readable summary",
    };
    const buildProof = vi.fn(async () => proof);
    const { server, p } = serverWithProof(buildProof, ["audit:read"]);
    const res = await server.handle(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "resources/read",
        params: { uri: "brain://proofs/act_X" },
      },
      p,
    );
    expect("result" in res).toBe(true);
    if ("result" in res) {
      const r = res.result as { contents: Array<{ text: string }> };
      const body = JSON.parse(r.contents[0]!.text) as { action_id: string };
      expect(body.action_id).toBe("act_X");
    }
    expect(buildProof).toHaveBeenCalledWith(TENANT, "act_X");
  });

  it("404s for an unknown action (tenant-isolated — never leaks existence)", async () => {
    const buildProof = vi.fn(async () => null);
    const { server, p } = serverWithProof(buildProof, ["audit:read"]);
    const res = await server.handle(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "resources/read",
        params: { uri: "brain://proofs/act_MISSING" },
      },
      p,
    );
    expect("error" in res).toBe(true);
  });

  it("errors with internal_server_error when buildProof is unwired", async () => {
    const { server, p } = serverWithProof(undefined, ["audit:read"]);
    const res = await server.handle(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "resources/read",
        params: { uri: "brain://proofs/act_X" },
      },
      p,
    );
    expect("error" in res).toBe(true);
  });

  it("blocks when audit:read is missing", async () => {
    // The scope check runs AFTER readResource builds the body, so we need
    // buildProof to succeed for the scope rejection to be the surfaced error.
    const buildProof = vi.fn(async () => ({
      action_id: "act_X",
      tenant_id: TENANT,
      agent_id: AGENT_ID,
      behavior_hash: null,
      outcome: "executed",
      policy_version: "v1",
      policy_hash: "0x",
      matched_rule_id: null,
      gate_checks: [],
      evidence: [],
      ledger_snapshot_hash: "0x",
      audit_events: [],
      merkle_root: "0x",
      merkle_proof: [],
      chain_anchor: null,
      rail_receipt: null,
      human_explanation: "",
    }));
    const { server, p } = serverWithProof(buildProof, ["ledger:read"]);
    const res = await server.handle(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "resources/read",
        params: { uri: "brain://proofs/act_X" },
      },
      p,
    );
    expect("error" in res && res.error.code).toBe(-32002);
  });
});

describe("BrainMcpServer.handle — remaining prompt renders", () => {
  it("prompts/get renders wiki.question.bills_due with default days", async () => {
    const { server, p } = makeServer();
    const res = await server.handle(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "prompts/get",
        params: { name: "wiki.question.bills_due", arguments: {} },
      },
      p,
    );
    expect("result" in res).toBe(true);
    if ("result" in res) {
      const r = res.result as { messages: Array<{ content: { text: string } }> };
      expect(r.messages[0]!.content.text).toContain("7");
    }
  });

  it("prompts/get renders wiki.question.spending_change", async () => {
    const { server, p } = makeServer();
    const res = await server.handle(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "prompts/get",
        params: { name: "wiki.question.spending_change", arguments: { period: "2026-Q1" } },
      },
      p,
    );
    expect("result" in res).toBe(true);
    if ("result" in res) {
      const r = res.result as { messages: Array<{ content: { text: string } }> };
      expect(r.messages[0]!.content.text).toContain("2026-Q1");
    }
  });

  it("prompts/get renders wiki.question.invoice_status", async () => {
    const { server, p } = makeServer();
    const res = await server.handle(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "prompts/get",
        params: { name: "wiki.question.invoice_status", arguments: { invoice_number: "INV-42" } },
      },
      p,
    );
    expect("result" in res).toBe(true);
    if ("result" in res) {
      const r = res.result as { messages: Array<{ content: { text: string } }> };
      expect(r.messages[0]!.content.text).toContain("INV-42");
    }
  });

  it("prompts/get renders wiki.question.subscriptions (no args)", async () => {
    const { server, p } = makeServer();
    const res = await server.handle(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "prompts/get",
        params: { name: "wiki.question.subscriptions", arguments: {} },
      },
      p,
    );
    expect("result" in res).toBe(true);
    if ("result" in res) {
      const r = res.result as { messages: Array<{ content: { text: string } }> };
      expect(r.messages[0]!.content.text).toContain("subscriptions");
    }
  });

  it("prompts/get rejects unknown prompt name", async () => {
    const { server, p } = makeServer();
    const res = await server.handle(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "prompts/get",
        params: { name: "no.such.prompt", arguments: {} },
      },
      p,
    );
    expect("error" in res && res.error.code).toBe(-32602);
  });
});

describe("BrainMcpServer.handle — wiki.page.get tool", () => {
  it("returns not-found summary when page is null", async () => {
    const { server, p } = makeServer(["wiki:read"]);
    const res = await server.handle(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "wiki.page.get", arguments: { slug_or_id: "/accounts/acct_MISSING" } },
      },
      p,
    );
    expect("result" in res).toBe(true);
    if ("result" in res) {
      const r = res.result as { content: Array<{ text: string }> };
      expect(r.content[0]!.text).toContain("No wiki page");
    }
  });

  it("returns page body when page is found", async () => {
    const audit = new InMemoryAuditEmitter();
    const wiki = fakeWiki();
    (wiki.getPage as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "wpg_01",
      slug: "/accounts/acct_1",
      entity_type: "account",
      entity_id: "acct_1",
      body_md: "# Account summary\nBalance: $1,000",
      generated_at: new Date().toISOString(),
    });
    const server = new BrainMcpServer({
      auth: new FakeAuthVerifier(ACTIVE_AGENT),
      ledger: fakeLedger(),
      wiki,
      raw: fakeRaw(),
      paymentIntents: fakePI(),
      audit,
    });
    const res = await server.handle(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "wiki.page.get", arguments: { slug_or_id: "/accounts/acct_1" } },
      },
      principal(["wiki:read"]),
    );
    expect("result" in res).toBe(true);
    if ("result" in res) {
      const r = res.result as { content: Array<{ text: string }> };
      expect(r.content[0]!.text).toContain("Account summary");
    }
  });
});

describe("BrainMcpServer.handle — wiki.question optional params and evidence", () => {
  it("passes as_of and max_evidence_depth through to wiki service", async () => {
    const audit = new InMemoryAuditEmitter();
    const wiki = fakeWiki();
    (wiki.question as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      question: "any",
      answer: "Balance is $500",
      evidence: [{ entityId: "tx_01", entityType: "transaction", excerpt: "outflow $50" }],
      model: "test",
      usage: { inputTokens: 2, outputTokens: 2 },
    });
    const server = new BrainMcpServer({
      auth: new FakeAuthVerifier(ACTIVE_AGENT),
      ledger: fakeLedger(),
      wiki,
      raw: fakeRaw(),
      paymentIntents: fakePI(),
      audit,
    });
    const res = await server.handle(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "wiki.question",
          arguments: { question: "any", as_of: "2026-01-01T00:00:00Z", max_evidence_depth: 2 },
        },
      },
      principal(["wiki:read"]),
    );
    expect("result" in res).toBe(true);
    if ("result" in res) {
      const r = res.result as { content: Array<{ text: string }> };
      expect(r.content[0]!.text).toContain("tx_01");
    }
  });
});

describe("BrainMcpServer.handle — payment_intent.propose status variants", () => {
  function makeServerWithStatus(status: string) {
    const audit = new InMemoryAuditEmitter();
    const pi: IPaymentIntentService = {
      create: vi.fn(async (_ctx, input) => ({
        id: "pi_S",
        owner_id: TENANT,
        source_ids: [],
        evidence_ids: [],
        provenance: "inferred" as const,
        confidence: 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        created_by_agent_id: null,
        action_type: input.action_type,
        source_account_id: input.source_account_id,
        destination_counterparty_id: input.destination_counterparty_id,
        amount: input.amount,
        currency: input.currency,
        obligation_id: null,
        invoice_id: null,
        status: status as never,
        policy_decision_id: "pd_S",
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
    const server = new BrainMcpServer({
      auth: new FakeAuthVerifier(ACTIVE_AGENT),
      ledger: fakeLedger(),
      wiki: fakeWiki(),
      raw: fakeRaw(),
      paymentIntents: pi,
      audit,
    });
    return { server, p: principal(["payment_intent:propose"]) };
  }

  it("shows pending_approval guidance", async () => {
    const { server, p } = makeServerWithStatus("pending_approval");
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
            amount: "1.00",
            currency: "USD",
          },
        },
      },
      p,
    );
    expect("result" in res).toBe(true);
    if ("result" in res) {
      const r = res.result as { content: Array<{ text: string }> };
      expect(r.content[0]!.text).toContain("confirm");
    }
  });

  it("shows rejected guidance", async () => {
    const { server, p } = makeServerWithStatus("rejected");
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
            amount: "1.00",
            currency: "USD",
          },
        },
      },
      p,
    );
    expect("result" in res).toBe(true);
    if ("result" in res) {
      const r = res.result as { content: Array<{ text: string }> };
      expect(r.content[0]!.text).toContain("reject");
    }
  });
});

// ---------------------------------------------------------------------------
// Batch 12: hostile-input + rejection-audit coverage.
//
// Pre-batch-12 the MCP server only emitted `agent.mcp.tool_called` on the
// SUCCESS path. Every rejection -- bad scope, unknown tool, parse fail,
// tenant mismatch, on-chain scope-hash drift -- left no audit row, so a
// determined caller could probe the surface invisibly. These tests pin the
// new behaviour: every rejection emits exactly one `agent.mcp.tool_called`
// row with `ok: false` and a stable error code in outputs.
// ---------------------------------------------------------------------------

/** AuthVerifier that always throws the supplied error -- exercises auth-stage rejections. */
class ThrowingAuthVerifier implements AuthVerifier {
  public constructor(private readonly err: Error) {}
  public async verify(_principal: Principal): Promise<{
    agent: AgentRecord;
    ctx: ServiceCallContext;
  }> {
    throw this.err;
  }
}

function makeServerWith(verifier: AuthVerifier, scopes: string[] = []) {
  const audit = new InMemoryAuditEmitter();
  const server = new BrainMcpServer({
    auth: verifier,
    ledger: fakeLedger(),
    wiki: fakeWiki(),
    raw: fakeRaw(),
    paymentIntents: fakePI(),
    audit,
  });
  return { server, audit, p: principal(scopes) };
}

describe("BrainMcpServer.handle -- rejection-audit emission (batch 12)", () => {
  it("emits agent.mcp.tool_called {ok:false, error_code} on scope mismatch", async () => {
    const { server, audit, p } = makeServer(["wiki:read"]); // lacking ledger:read
    const res = await server.handle(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "ledger.account.get", arguments: { account_id: "acct_x" } },
      },
      p,
    );
    expect("error" in res).toBe(true);

    const rows = audit.events.filter((e) => e.action === "agent.mcp.tool_called");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outputs).toMatchObject({
      ok: false,
      error_code: "auth_scope_insufficient",
    });
    expect(rows[0]?.inputs).toMatchObject({ tool: "ledger.account.get" });
    // Tenant + actor are taken from the verified ctx (FakeAuthVerifier passes).
    expect(rows[0]?.tenantId).toBe(TENANT);
    expect(rows[0]?.actor).toBe(AGENT_ID);
  });

  it("emits a rejection row on unknown tool", async () => {
    const { server, audit, p } = makeServer(["ledger:read"]);
    await server.handle(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "ledger.banana.list", arguments: {} },
      },
      p,
    );
    const rows = audit.events.filter((e) => e.action === "agent.mcp.tool_called");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outputs).toMatchObject({
      ok: false,
      error_code: "request_params_invalid",
    });
  });

  it("emits a rejection row when tool input fails to parse", async () => {
    // ledger.account.get requires `account_id`; we pass empty arguments.
    const { server, audit, p } = makeServer(["ledger:read"]);
    await server.handle(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "ledger.account.get", arguments: {} },
      },
      p,
    );
    const rows = audit.events.filter((e) => e.action === "agent.mcp.tool_called");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outputs).toMatchObject({ ok: false });
  });

  it("emits a rejection row when auth.verify throws (tenant mismatch)", async () => {
    // Auth-stage failures don't have a verified ctx yet, so the audit row
    // keys to the principal's CLAIMED tenant + actor. The act of recording
    // the rejection IS the value -- it tells the operator who probed.
    const verifier = new ThrowingAuthVerifier(
      brainError("auth_tenant_mismatch", "agent tenant does not match JWT tenant"),
    );
    const { server, audit, p } = makeServerWith(verifier, ["ledger:read"]);

    await expect(
      server.handle(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "ledger.account.get", arguments: { account_id: "acct_x" } },
        },
        p,
      ),
    ).rejects.toMatchObject({ code: "auth_tenant_mismatch" });

    const rows = audit.events.filter((e) => e.action === "agent.mcp.tool_called");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outputs).toMatchObject({
      ok: false,
      error_code: "auth_tenant_mismatch",
    });
    expect(rows[0]?.inputs).toMatchObject({ tool: "auth.verify" });
    expect(rows[0]?.tenantId).toBe(TENANT);
    expect(rows[0]?.actor).toBe(AGENT_ID);
  });

  it("emits a rejection row on on-chain scope_hash drift", async () => {
    const verifier = new ThrowingAuthVerifier(
      brainError("agent_scope_hash_mismatch", "scope hash drift detected"),
    );
    const { server, audit, p } = makeServerWith(verifier, ["ledger:read"]);

    await expect(
      server.handle(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "ledger.account.get", arguments: { account_id: "acct_x" } },
        },
        p,
      ),
    ).rejects.toMatchObject({ code: "agent_scope_hash_mismatch" });

    const rows = audit.events.filter((e) => e.action === "agent.mcp.tool_called");
    expect(rows[0]?.outputs).toMatchObject({
      ok: false,
      error_code: "agent_scope_hash_mismatch",
    });
  });

  it("emits a rejection row on resources/read scope mismatch", async () => {
    // resources.read takes the same audit path as tools/call.
    const { server, audit, p } = makeServer(["wiki:read"]); // lacking ledger:read
    await server.handle(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "resources/read",
        params: { uri: "brain://ledger/accounts/acct_x" },
      },
      p,
    );
    const rows = audit.events.filter((e) => e.action === "agent.mcp.tool_called");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const lastRow = rows[rows.length - 1];
    expect(lastRow?.outputs).toMatchObject({ ok: false });
    expect(lastRow?.inputs).toMatchObject({
      tool: "resources.read:brain://ledger/accounts/acct_x",
    });
  });

  it("does NOT emit a rejection row on the happy path (single ok:true row only)", async () => {
    // Sanity check: the rejection path must not double-emit on success.
    const { server, audit, p } = makeServer(["wiki:read"]);
    await server.handle(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "wiki.question", arguments: { question: "balance?" } },
      },
      p,
    );
    const rows = audit.events.filter((e) => e.action === "agent.mcp.tool_called");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outputs).toMatchObject({ ok: true });
  });

  it("audit emitter failure does NOT mask the original rejection", async () => {
    // When the auth verifier throws AND the audit emitter also throws, the
    // server still surfaces the original auth error to the caller. The audit
    // sink failure is logged-and-swallowed (defensive design: we never want
    // audit to be a vector for hiding the underlying problem).
    class BadEmitter {
      public emit = vi.fn(async () => {
        throw new Error("audit sink down");
      });
    }
    const verifier = new ThrowingAuthVerifier(
      brainError("agent_scope_hash_mismatch", "scope hash drift"),
    );
    const server = new BrainMcpServer({
      auth: verifier,
      ledger: fakeLedger(),
      wiki: fakeWiki(),
      raw: fakeRaw(),
      paymentIntents: fakePI(),
      audit: new BadEmitter() as unknown as InMemoryAuditEmitter,
    });
    await expect(
      server.handle(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "any.tool" } },
        principal([]),
      ),
    ).rejects.toMatchObject({ code: "agent_scope_hash_mismatch" });
  });
});
