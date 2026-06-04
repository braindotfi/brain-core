import type { Redis } from "ioredis";
import { describe, expect, it } from "vitest";
import {
  DeterministicEmbeddingAdapter,
  MockMetrics,
  RecordedLlmAdapter,
  llmKey,
  type TenantScopedClient,
} from "@brain/shared";
import { askWiki } from "./orchestrator.js";

/**
 * v0.3 — orchestrator grounds in Ledger rows. The fake client returns
 * three Ledger row sets in the order the orchestrator queries them:
 *   1) ledger_transactions
 *   2) ledger_obligations
 *   3) ledger_counterparties
 */

interface FakeRows {
  transactions: Array<{
    id: string;
    amount: string;
    currency: string;
    direction: string;
    transaction_date: Date;
    description_normalized: string | null;
    description_raw: string | null;
    counterparty_id: string | null;
  }>;
  obligations: Array<{
    id: string;
    type: string;
    amount_due: string;
    currency: string;
    due_date: Date;
    status: string;
    counterparty_id: string;
  }>;
  counterparties: Array<{
    id: string;
    name: string;
    type: string;
    risk_level: string | null;
  }>;
}

function fakeRedis(): {
  get: (k: string) => Promise<string | null>;
  set: (...args: unknown[]) => Promise<string>;
} {
  const store = new Map<string, string>();
  return {
    async get(k: string) {
      return store.get(k) ?? null;
    },
    async set(...args: unknown[]) {
      const [k, v] = args as [string, string];
      store.set(k, v);
      return "OK";
    },
  };
}

function fakeClient(rows: FakeRows): TenantScopedClient {
  return {
    query: async (text: string) => {
      if (text.includes("FROM ledger_transactions")) {
        return { rows: rows.transactions as never[], rowCount: rows.transactions.length };
      }
      if (text.includes("FROM ledger_obligations")) {
        return { rows: rows.obligations as never[], rowCount: rows.obligations.length };
      }
      if (text.includes("FROM ledger_counterparties")) {
        return { rows: rows.counterparties as never[], rowCount: rows.counterparties.length };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

function buildEvidenceContext(rows: FakeRows): string {
  const lines: string[] = [];
  for (const r of rows.transactions) {
    const cp = r.counterparty_id !== null ? ` cp=${r.counterparty_id}` : "";
    const memo = r.description_normalized ?? r.description_raw ?? "";
    lines.push(
      `[${r.id}] (transaction) ${r.direction} ${r.amount} ${r.currency} on ${r.transaction_date.toISOString().slice(0, 10)}${cp} ${memo}`.trim(),
    );
  }
  for (const r of rows.obligations) {
    lines.push(
      `[${r.id}] (obligation) ${r.type} due ${r.due_date.toISOString().slice(0, 10)} amount ${r.amount_due} ${r.currency} status=${r.status} cp=${r.counterparty_id}`,
    );
  }
  for (const r of rows.counterparties) {
    const risk = r.risk_level !== null ? ` risk=${r.risk_level}` : "";
    lines.push(`[${r.id}] (counterparty) ${r.type} "${r.name}"${risk}`);
  }
  return lines.join("\n");
}

const SYSTEM_PROMPT =
  "You answer questions about a tenant's financial data grounded ONLY in the EVIDENCE block. Each evidence row has a typed id like `tx_..`, `obl_..`, or `cp_..`. Reply as JSON { answer, evidence_ids }. evidence_ids must be a subset of the EVIDENCE block ids.";

describe("askWiki — Ledger-grounded retrieval", () => {
  it("returns a grounded answer citing only retrieved Ledger rows", async () => {
    const rows: FakeRows = {
      transactions: [
        {
          id: "tx_01HQ7K3AAAAAAAAAAAAAAAAAAAA",
          amount: "4.50",
          currency: "USD",
          direction: "outflow",
          transaction_date: new Date("2026-04-12T00:00:00Z"),
          description_normalized: "Blue Bottle",
          description_raw: "Blue Bottle Coffee",
          counterparty_id: "cp_BBB",
        },
        {
          id: "tx_01HQ7K3BBBBBBBBBBBBBBBBBBBB",
          amount: "2500.00",
          currency: "USD",
          direction: "outflow",
          transaction_date: new Date("2026-04-01T00:00:00Z"),
          description_normalized: "rent",
          description_raw: "Rent April",
          counterparty_id: null,
        },
      ],
      obligations: [],
      counterparties: [],
    };

    const evidenceContext = buildEvidenceContext(rows);
    const prompt = {
      model: "claude-opus-4-7",
      messages: [
        { role: "system" as const, content: SYSTEM_PROMPT },
        {
          role: "user" as const,
          content: `QUESTION:\nwhat was my biggest expense last month\n\nEVIDENCE:\n${evidenceContext}`,
        },
      ],
      temperature: 0,
      maxTokens: 800,
      timeoutMs: 15_000,
    };
    const llm = new RecordedLlmAdapter([
      {
        key: llmKey(prompt),
        response: {
          text: `{"answer":"Rent at $2,500 was the biggest expense.","evidence_ids":["${rows.transactions[1]!.id}","tx_NOT_RETRIEVED"]}`,
          usage: { inputTokens: 120, outputTokens: 40 },
          model: "claude-opus-4-7",
          finishReason: "end_turn",
        },
      },
    ]);

    const result = await askWiki(
      {
        client: fakeClient(rows),
        llm,
        embed: new DeterministicEmbeddingAdapter(16),
        redis: fakeRedis() as unknown as Redis,
        metrics: new MockMetrics(),
      },
      {
        question: "what was my biggest expense last month",
        asOf: null,
        maxEvidenceDepth: 3,
        tenantId: "tnt_test",
        model: "claude-opus-4-7",
      },
    );

    expect(result.answer).toContain("Rent");
    // §11.2 prompt-injection mitigation — evidence_ids filtered to retrieved set.
    expect(result.evidence.map((e) => e.entityId)).toEqual([rows.transactions[1]!.id]);
    expect(result.evidence[0]!.entityType).toBe("transaction");
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 40 });
  });

  it("replays from cache on the second call (cost control)", async () => {
    const rows: FakeRows = {
      transactions: [
        {
          id: "tx_CACHE",
          amount: "1.00",
          currency: "USD",
          direction: "outflow",
          transaction_date: new Date("2026-04-01T00:00:00Z"),
          description_normalized: "x",
          description_raw: null,
          counterparty_id: null,
        },
      ],
      obligations: [],
      counterparties: [],
    };
    const evidenceContext = buildEvidenceContext(rows);
    const prompt = {
      model: "m",
      messages: [
        { role: "system" as const, content: SYSTEM_PROMPT },
        { role: "user" as const, content: `QUESTION:\nq\n\nEVIDENCE:\n${evidenceContext}` },
      ],
      temperature: 0,
      maxTokens: 800,
      timeoutMs: 15_000,
    };

    const llm = new RecordedLlmAdapter([
      {
        key: llmKey(prompt),
        response: {
          text: `{"answer":"A","evidence_ids":[]}`,
          usage: { inputTokens: 1, outputTokens: 1 },
          model: "m",
          finishReason: "end_turn",
        },
      },
    ]);
    const metrics = new MockMetrics();
    const deps = {
      client: fakeClient(rows),
      llm,
      embed: new DeterministicEmbeddingAdapter(16),
      redis: fakeRedis() as unknown as Redis,
      metrics,
    };
    const opts = {
      question: "q",
      asOf: null,
      maxEvidenceDepth: 3,
      tenantId: "tnt_test",
      model: "m",
    };

    const first = await askWiki(deps, opts);
    const second = await askWiki(deps, opts);
    expect(first.answer).toBe("A");
    expect(second.answer).toBe("A");
    expect(second.cachedAt).toBeTypeOf("string");
    expect(metrics.calls.some((c) => c.name === "brain.wiki.question.cache_hit")).toBe(true);
  });

  it("includes risk_level in counterparty excerpt when non-null", async () => {
    const rows: FakeRows = {
      transactions: [],
      obligations: [],
      counterparties: [{ id: "cp_RISK", name: "Risky Corp", type: "vendor", risk_level: "high" }],
    };
    const evidenceContext = buildEvidenceContext(rows);
    const prompt = {
      model: "m2",
      messages: [
        { role: "system" as const, content: SYSTEM_PROMPT },
        {
          role: "user" as const,
          content: `QUESTION:\nwho is risky\n\nEVIDENCE:\n${evidenceContext}`,
        },
      ],
      temperature: 0,
      maxTokens: 800,
      timeoutMs: 15_000,
    };
    const llm = new RecordedLlmAdapter([
      {
        key: llmKey(prompt),
        response: {
          text: `{"answer":"Risky Corp is high risk.","evidence_ids":["cp_RISK"]}`,
          usage: { inputTokens: 10, outputTokens: 5 },
          model: "m2",
          finishReason: "end_turn",
        },
      },
    ]);
    const result = await askWiki(
      {
        client: fakeClient(rows),
        llm,
        embed: new DeterministicEmbeddingAdapter(16),
        redis: fakeRedis() as unknown as Redis,
        metrics: new MockMetrics(),
      },
      {
        question: "who is risky",
        asOf: null,
        maxEvidenceDepth: 3,
        tenantId: "tnt_test",
        model: "m2",
      },
    );
    expect(result.answer).toContain("Risky Corp");
    expect(result.evidence[0]!.entityId).toBe("cp_RISK");
  });

  it("grounds in obligation rows (covers the obligation candidate path)", async () => {
    const rows: FakeRows = {
      transactions: [],
      obligations: [
        {
          id: "obl_DUE1",
          type: "subscription",
          amount_due: "29.00",
          currency: "USD",
          due_date: new Date("2026-05-01T00:00:00Z"),
          status: "upcoming",
          counterparty_id: "cp_SUB",
        },
      ],
      counterparties: [],
    };
    const evidenceContext = buildEvidenceContext(rows);
    const prompt = {
      model: "m4",
      messages: [
        { role: "system" as const, content: SYSTEM_PROMPT },
        {
          role: "user" as const,
          content: `QUESTION:\nwhat bills are due\n\nEVIDENCE:\n${evidenceContext}`,
        },
      ],
      temperature: 0,
      maxTokens: 800,
      timeoutMs: 15_000,
    };
    const llm = new RecordedLlmAdapter([
      {
        key: llmKey(prompt),
        response: {
          text: `{"answer":"A $29 subscription is due May 1.","evidence_ids":["obl_DUE1"]}`,
          usage: { inputTokens: 8, outputTokens: 6 },
          model: "m4",
          finishReason: "end_turn",
        },
      },
    ]);
    const result = await askWiki(
      {
        client: fakeClient(rows),
        llm,
        embed: new DeterministicEmbeddingAdapter(16),
        redis: fakeRedis() as unknown as Redis,
        metrics: new MockMetrics(),
      },
      {
        question: "what bills are due",
        asOf: null,
        maxEvidenceDepth: 3,
        tenantId: "tnt_test",
        model: "m4",
      },
    );
    expect(result.evidence[0]!.entityId).toBe("obl_DUE1");
    expect(result.evidence[0]!.entityType).toBe("obligation");
  });

  it("links an extracted obligation to its counterparty (what do I owe, and to whom)", async () => {
    // The document_extractor path (RFC 0004) writes an obligation + the vendor
    // it is owed to. The obligation excerpt must carry cp= so the model can
    // join the two and name the payee.
    const rows: FakeRows = {
      transactions: [],
      obligations: [
        {
          id: "obl_BILL1",
          type: "bill",
          amount_due: "120.50",
          currency: "USD",
          due_date: new Date("2026-07-01T00:00:00Z"),
          status: "upcoming",
          counterparty_id: "cp_ACME",
        },
      ],
      counterparties: [{ id: "cp_ACME", name: "Acme Utilities", type: "vendor", risk_level: null }],
    };
    const evidenceContext = buildEvidenceContext(rows);
    // Assert the obligation excerpt actually carries the counterparty link.
    expect(evidenceContext).toContain("(obligation) bill due 2026-07-01 amount 120.50 USD");
    expect(evidenceContext).toContain("cp=cp_ACME");

    const prompt = {
      model: "m5",
      messages: [
        { role: "system" as const, content: SYSTEM_PROMPT },
        {
          role: "user" as const,
          content: `QUESTION:\nwhat do I owe and to whom\n\nEVIDENCE:\n${evidenceContext}`,
        },
      ],
      temperature: 0,
      maxTokens: 800,
      timeoutMs: 15_000,
    };
    const llm = new RecordedLlmAdapter([
      {
        key: llmKey(prompt),
        response: {
          text: `{"answer":"You owe Acme Utilities $120.50, due July 1.","evidence_ids":["obl_BILL1","cp_ACME"]}`,
          usage: { inputTokens: 14, outputTokens: 9 },
          model: "m5",
          finishReason: "end_turn",
        },
      },
    ]);
    const result = await askWiki(
      {
        client: fakeClient(rows),
        llm,
        embed: new DeterministicEmbeddingAdapter(16),
        redis: fakeRedis() as unknown as Redis,
        metrics: new MockMetrics(),
      },
      {
        question: "what do I owe and to whom",
        asOf: null,
        maxEvidenceDepth: 3,
        tenantId: "tnt_test",
        model: "m5",
      },
    );
    expect(result.answer).toContain("Acme Utilities");
    expect(result.evidence.map((e) => e.entityId).sort()).toEqual(["cp_ACME", "obl_BILL1"]);
  });

  it("falls back to raw text when LLM returns non-JSON", async () => {
    const rows: FakeRows = { transactions: [], obligations: [], counterparties: [] };
    const evidenceContext = buildEvidenceContext(rows);
    const prompt = {
      model: "m3",
      messages: [
        { role: "system" as const, content: SYSTEM_PROMPT },
        { role: "user" as const, content: `QUESTION:\ntest\n\nEVIDENCE:\n${evidenceContext}` },
      ],
      temperature: 0,
      maxTokens: 800,
      timeoutMs: 15_000,
    };
    const llm = new RecordedLlmAdapter([
      {
        key: llmKey(prompt),
        response: {
          text: "This is not JSON at all.",
          usage: { inputTokens: 5, outputTokens: 5 },
          model: "m3",
          finishReason: "end_turn",
        },
      },
    ]);
    const result = await askWiki(
      {
        client: fakeClient(rows),
        llm,
        embed: new DeterministicEmbeddingAdapter(16),
        redis: fakeRedis() as unknown as Redis,
        metrics: new MockMetrics(),
      },
      { question: "test", asOf: null, maxEvidenceDepth: 3, tenantId: "tnt_test", model: "m3" },
    );
    expect(result.answer).toBe("This is not JSON at all.");
    expect(result.evidence).toHaveLength(0);
  });
});
