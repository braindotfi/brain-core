import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  errorHandlerPlugin,
  GROUNDED_ANSWER_FALLBACK,
  newTenantId,
  newUserId,
  type Principal,
  type Scope,
} from "@brain/shared";
import type { Pool } from "pg";
import { registerAssistantQuestionsRoute } from "./questions-route.js";

const TENANT = newTenantId();
const USER = newUserId();

const principal = (scopes: Scope[] = ["wiki:read"]): Principal => ({
  id: USER,
  type: "user",
  tenantId: TENANT,
  scopes,
  tokenId: "tok_1",
  expiresAt: Math.floor(Date.now() / 1000) + 900,
});

function fakePool(
  rows: Array<Record<string, unknown>>,
  error?: Error & { code?: string },
): { pool: Pool; queries: string[]; warn: ReturnType<typeof vi.fn> } {
  const queries: string[] = [];
  const warn = vi.fn();
  const client = {
    query: vi.fn(async (sql: string) => {
      queries.push(sql);
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      if (sql.startsWith("SELECT set_config")) return { rows: [] };
      if (error !== undefined && sql.includes("FROM assistant_questions")) {
        throw error;
      }
      if (sql.includes("FROM assistant_questions")) return { rows };
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  return {
    pool: { connect: async () => client } as unknown as Pool,
    queries,
    warn,
  };
}

async function buildApp(pool: Pool, warn: ReturnType<typeof vi.fn>, scopes?: Scope[]) {
  const app = Fastify();
  await app.register(errorHandlerPlugin);
  app.addHook("preHandler", async (request) => {
    request.principal = principal(scopes);
  });
  await registerAssistantQuestionsRoute(app, { pool, log: { warn } as never });
  return app;
}

describe("GET /assistant/questions", () => {
  it("returns tenant-scoped assistant questions", async () => {
    const { pool, queries, warn } = fakePool([
      {
        id: "asq_1",
        question: "What changed in cash?",
        answer: null,
        status: "suggested",
        source: "wiki",
        evidence_ids: null,
        metadata: null,
        created_at: new Date("2026-07-01T00:00:00Z"),
        updated_at: "2026-07-01T00:01:00.000Z",
      },
    ]);
    const app = await buildApp(pool, warn);

    const res = await app.inject({ method: "GET", url: "/assistant/questions?limit=5" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      questions: [
        {
          id: "asq_1",
          question: "What changed in cash?",
          answer: null,
          status: "suggested",
          source: "wiki",
          evidence_ids: [],
          metadata: {},
          created_at: "2026-07-01T00:00:00.000Z",
          updated_at: "2026-07-01T00:01:00.000Z",
        },
      ],
    });
    expect(queries.some((q) => q.includes("tenant_id = current_setting"))).toBe(true);
    await app.close();
  });

  it("guards stored answers before returning them", async () => {
    const { pool, warn } = fakePool([
      {
        id: "asq_raw",
        question: "What's my total AR?",
        answer: `{"answer":"$133,438","evidence_ids":["obl_1"],"tenant_id":"tnt_other"}`,
        status: "answered",
        source: "wiki",
        evidence_ids: ["obl_1"],
        metadata: {},
        created_at: new Date("2026-07-01T00:00:00Z"),
        updated_at: "2026-07-01T00:01:00.000Z",
      },
    ]);
    const app = await buildApp(pool, warn);

    const res = await app.inject({ method: "GET", url: "/assistant/questions?limit=5" });

    expect(res.statusCode).toBe(200);
    expect(res.json().questions[0].answer).toBe(GROUNDED_ANSWER_FALLBACK);
    expect(res.json().questions[0].evidence_ids).toEqual(["obl_1"]);
    await app.close();
  });

  it("returns an empty list when the table is not present yet", async () => {
    const missing = new Error("relation assistant_questions does not exist") as Error & {
      code?: string;
    };
    missing.code = "42P01";
    const { pool, warn } = fakePool([], missing);
    const app = await buildApp(pool, warn);

    const res = await app.inject({ method: "GET", url: "/assistant/questions" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ questions: [] });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: TENANT }),
      "assistant_questions table missing; returning empty questions list",
    );
    await app.close();
  });

  it("requires wiki read scope", async () => {
    const { pool, warn } = fakePool([]);
    const app = await buildApp(pool, warn, ["ledger:read"]);

    const res = await app.inject({ method: "GET", url: "/assistant/questions" });

    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
