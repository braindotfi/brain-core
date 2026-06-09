import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { errorHandlerPlugin, newTenantId } from "@brain/shared";
import type { Pool } from "pg";
import { registerSearch } from "./search.js";
import type { WikiDeps } from "../deps.js";

describe("GET /wiki/search query-param validation (F-2)", () => {
  function buildApp(): ReturnType<typeof Fastify> {
    const app = Fastify();
    void app.register(errorHandlerPlugin);
    app.addHook("onRequest", async (req) => {
      (req as unknown as { principal: unknown }).principal = {
        tenantId: newTenantId(),
        id: "user_1",
        type: "user",
        scopes: ["wiki:read"],
      };
    });
    const client = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
      release: vi.fn(),
    };
    const pool = { connect: async () => client } as unknown as Pool;
    void registerSearch(app, { pool } as unknown as WikiDeps);
    return app;
  }

  it("rejects a non-numeric or negative limit with 400, never a pg 500", async () => {
    const app = buildApp();
    for (const bad of ["abc", "-5", "0"]) {
      const res = await app.inject({ method: "GET", url: `/wiki/search?q=x&limit=${bad}` });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("request_params_invalid");
    }
    await app.close();
  });

  it("still accepts a valid limit", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/wiki/search?q=x&limit=10" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
