import { describe, expect, it } from "vitest";
import {
  DeterministicEmbeddingAdapter,
  MockMetrics,
  RecordedLlmAdapter,
  llmKey,
  type TenantScopedClient,
} from "@brain/api/shared";
import { askWiki } from "./orchestrator.js";
import type { WikiEntityRow } from "../repository/entities.js";

function fakeRedis(): {
  get: (k: string) => Promise<string | null>;
  set: (...args: unknown[]) => Promise<string>;
  _store: Map<string, string>;
} {
  const store = new Map<string, string>();
  return {
    _store: store,
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

function fakeClient(candidates: WikiEntityRow[]): TenantScopedClient {
  return {
    query: async (text: string, _values?: ReadonlyArray<unknown>) => {
      if (text.includes("ORDER BY embedding")) {
        return { rows: candidates as unknown as Record<string, unknown>[], rowCount: candidates.length };
      }
      if (text.includes("FROM wiki_relations")) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

function makeEntity(id: string, memo: string): WikiEntityRow {
  return {
    id,
    tenant_id: "tnt_test",
    kind: "transaction",
    attributes: { memo, amount: "100.00", currency: "USD" },
    embedding: null,
    valid_from: new Date("2026-04-01"),
    valid_to: null,
    provenance: "extracted",
    confidence: 0.9,
    source_evidence: ["prs_abc"],
    superseded_by: null,
    supersedes: null,
    created_at: new Date("2026-04-01"),
  };
}

describe("askWiki", () => {
  it("returns a grounded answer citing only retrieved evidence", async () => {
    const candidates = [
      makeEntity("ent_01HQ7K3AAAAAAAAAAAAAAAAAAAA", "coffee 4.50"),
      makeEntity("ent_01HQ7K3BBBBBBBBBBBBBBBBBBBB", "rent 2500"),
    ];
    const redis = fakeRedis();
    const metrics = new MockMetrics();
    const embed = new DeterministicEmbeddingAdapter(16);

    // Construct a matching recorded completion. The orchestrator builds a
    // specific prompt; we re-build it here to produce the right key.
    const evidenceContext =
      `[${candidates[0]!.id}] kind=transaction attributes=${JSON.stringify(candidates[0]!.attributes)}\n` +
      `[${candidates[1]!.id}] kind=transaction attributes=${JSON.stringify(candidates[1]!.attributes)}`;
    const prompt = {
      model: "claude-opus-4-7",
      messages: [
        {
          role: "system" as const,
          content:
            "You answer questions about a tenant's financial data grounded ONLY in the EVIDENCE block. Reply as JSON { answer, evidence_ids }. Cite entity ids from the evidence.",
        },
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
          text: `{"answer":"Rent at $2,500 was the biggest expense.","evidence_ids":["${candidates[1]!.id}","ent_NOT_IN_RETRIEVED"]}`,
          usage: { inputTokens: 120, outputTokens: 40 },
          model: "claude-opus-4-7",
          finishReason: "end_turn",
        },
      },
    ]);

    const client = fakeClient(candidates);
    const result = await askWiki(
      { client, llm, embed, redis: redis as unknown as import("ioredis").Redis, metrics },
      {
        question: "what was my biggest expense last month",
        asOf: null,
        maxEvidenceDepth: 3,
        tenantId: "tnt_test",
        model: "claude-opus-4-7",
      },
    );

    expect(result.answer).toContain("Rent");
    // Prompt-injection mitigation §11.2: evidence-ids filtered to retrieved set.
    expect(result.evidence.map((e) => e.entityId)).toEqual([candidates[1]!.id]);
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 40 });

    // Metrics emitted.
    expect(metrics.calls.some((c) => c.name === "brain.wiki.question.latency")).toBe(true);
    expect(metrics.calls.some((c) => c.name === "brain.wiki.question.cost")).toBe(true);
  });

  it("replays from cache on the second call (cost control)", async () => {
    const candidates = [makeEntity("ent_01HQ7K3AAAAAAAAAAAAAAAAAAAA", "c")];
    const redis = fakeRedis();
    const metrics = new MockMetrics();
    const embed = new DeterministicEmbeddingAdapter(16);

    const evidenceContext = `[${candidates[0]!.id}] kind=transaction attributes=${JSON.stringify(candidates[0]!.attributes)}`;
    const prompt = {
      model: "m",
      messages: [
        {
          role: "system" as const,
          content:
            "You answer questions about a tenant's financial data grounded ONLY in the EVIDENCE block. Reply as JSON { answer, evidence_ids }. Cite entity ids from the evidence.",
        },
        {
          role: "user" as const,
          content: `QUESTION:\nq\n\nEVIDENCE:\n${evidenceContext}`,
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
          text: `{"answer":"A","evidence_ids":[]}`,
          usage: { inputTokens: 1, outputTokens: 1 },
          model: "m",
          finishReason: "end_turn",
        },
      },
    ]);

    const deps = {
      client: fakeClient(candidates),
      llm,
      embed,
      redis: redis as unknown as import("ioredis").Redis,
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
});
