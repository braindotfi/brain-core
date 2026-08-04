import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { InMemoryAuditEmitter, errorHandlerPlugin, newTenantId, newUserId } from "@brain/shared";
import { registerQuestion } from "./question.js";
import { registerSuggestedQuestions } from "./suggested-questions.js";
import {
  askWiki,
  listSuggestedQuestions,
  recordDeterministicIntentUsage,
} from "../question/orchestrator.js";
import type { WikiDeps } from "../deps.js";

vi.mock("../question/orchestrator.js", () => ({
  askWiki: vi.fn(async () => ({
    answered: true,
    answer: "Revenue increased.",
    evidence: [],
    model: "test-model",
    usage: { inputTokens: 10, outputTokens: 4 },
  })),
  recordDeterministicIntentUsage: vi.fn(async () => undefined),
  listSuggestedQuestions: vi.fn(async () => [
    {
      intentId: "transaction_listing",
      displayText: "Show my last 10 transactions",
      usageRankScore: 4,
    },
  ]),
}));

function buildPool(): Pool {
  const client = {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    release: vi.fn(),
  };
  return { connect: async () => client } as unknown as Pool;
}

describe("POST /wiki/question audit emission", () => {
  it("classifies wiki.question as assistant_activity and records the question text", async () => {
    const app = Fastify();
    await app.register(errorHandlerPlugin);
    const audit = new InMemoryAuditEmitter();
    const tenantId = newTenantId();
    const actor = newUserId();

    app.addHook("onRequest", async (request) => {
      request.principal = {
        id: actor,
        type: "user",
        tenantId,
        scopes: ["wiki:read"],
        tokenId: "jti_test",
        expiresAt: 9_999_999_999,
      };
    });

    const deps: WikiDeps = {
      pool: buildPool(),
      redis: {} as WikiDeps["redis"],
      audit,
      llm: {} as WikiDeps["llm"],
      embed: {} as WikiDeps["embed"],
      schemas: {} as WikiDeps["schemas"],
      metrics: {} as WikiDeps["metrics"],
      questionModel: "test-model",
    };
    await registerQuestion(app, deps);

    const res = await app.inject({
      method: "POST",
      url: "/wiki/question",
      payload: { question: "What changed in revenue?", max_evidence_depth: 2 },
    });

    expect(res.statusCode).toBe(200);
    expect(askWiki).toHaveBeenCalledOnce();
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({
      layer: "wiki",
      eventType: "assistant_activity",
      severity: "info",
      actor,
      action: "wiki.question",
      inputs: {
        question: "What changed in revenue?",
        question_length: 24,
        max_evidence_depth: 2,
        model: "test-model",
      },
      outputs: {
        answered: true,
        answer: "Revenue increased.",
        evidence_count: 0,
        input_tokens: 10,
        output_tokens: 4,
      },
    });
    expect(res.json()).toMatchObject({ answered: true, answer: "Revenue increased." });

    await app.close();
  });

  it("records tenant-scoped usage when a deterministic intent executes", async () => {
    const app = Fastify();
    await app.register(errorHandlerPlugin);
    const tenantId = newTenantId();
    app.addHook("onRequest", async (request) => {
      request.principal = {
        id: newUserId(),
        type: "user",
        tenantId,
        scopes: ["wiki:read"],
        tokenId: "jti_test",
        expiresAt: 9_999_999_999,
      };
    });
    const deps: WikiDeps = {
      pool: buildPool(),
      redis: {} as WikiDeps["redis"],
      audit: new InMemoryAuditEmitter(),
      llm: {} as WikiDeps["llm"],
      embed: {} as WikiDeps["embed"],
      schemas: {} as WikiDeps["schemas"],
      metrics: {} as WikiDeps["metrics"],
      questionModel: "test-model",
    };
    vi.mocked(askWiki).mockResolvedValueOnce({
      answered: true,
      answer: "You have 2 transactions.",
      evidence: [],
      model: "structured-ledger-query",
      usage: { inputTokens: 0, outputTokens: 0 },
      deterministicIntentId: "transaction_count",
    });
    await registerQuestion(app, deps);

    const res = await app.inject({
      method: "POST",
      url: "/wiki/question",
      payload: { question: "How many transactions do I have?" },
    });

    expect(res.statusCode).toBe(200);
    expect(recordDeterministicIntentUsage).toHaveBeenLastCalledWith(
      expect.anything(),
      "transaction_count",
    );
    await app.close();
  });
});

describe("GET /wiki/suggested-questions", () => {
  it("returns only tenant-scoped deterministic suggestions to wiki readers", async () => {
    const app = Fastify();
    await app.register(errorHandlerPlugin);
    const tenantId = newTenantId();
    app.addHook("onRequest", async (request) => {
      request.principal = {
        id: newUserId(),
        type: "user",
        tenantId,
        scopes: ["wiki:read"],
        tokenId: "jti_test",
        expiresAt: 9_999_999_999,
      };
    });
    const deps: WikiDeps = {
      pool: buildPool(),
      redis: {} as WikiDeps["redis"],
      audit: new InMemoryAuditEmitter(),
      llm: {} as WikiDeps["llm"],
      embed: {} as WikiDeps["embed"],
      schemas: {} as WikiDeps["schemas"],
      metrics: {} as WikiDeps["metrics"],
      questionModel: "test-model",
    };
    await registerSuggestedQuestions(app, deps);

    const res = await app.inject({ method: "GET", url: "/wiki/suggested-questions" });

    expect(res.statusCode).toBe(200);
    expect(listSuggestedQuestions).toHaveBeenCalledOnce();
    expect(res.json()).toEqual({
      suggestions: [
        {
          intent_id: "transaction_listing",
          display_text: "Show my last 10 transactions",
          usage_rank_score: 4,
        },
      ],
    });
    await app.close();
  });
});
