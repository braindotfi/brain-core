import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { InMemoryAuditEmitter, errorHandlerPlugin, newTenantId, newUserId } from "@brain/shared";
import { registerQuestion } from "./question.js";
import { askWiki } from "../question/orchestrator.js";
import type { WikiDeps } from "../deps.js";

vi.mock("../question/orchestrator.js", () => ({
  askWiki: vi.fn(async () => ({
    answer: "Revenue increased.",
    evidence: [],
    model: "test-model",
    usage: { inputTokens: 10, outputTokens: 4 },
  })),
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
    });

    await app.close();
  });
});
