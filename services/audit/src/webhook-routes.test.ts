/**
 * H-20 webhook dead-letter + replay route tests. Fastify app + injected
 * principal + fake pool (routes SQL by substring) + injected deliver fn, so the
 * list + replay flows are tested without Postgres or network.
 */

import { describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { errorHandlerPlugin, newTenantId, type Principal, type Scope } from "@brain/shared";
import type { Pool } from "pg";
import { registerWebhookRoutes, type WebhookRouteDeps } from "./webhook-routes.js";

const TENANT = newTenantId();

function principal(scopes: Scope[]): Principal {
  return {
    id: "user_1",
    type: "user",
    tenantId: TENANT,
    scopes,
    tokenId: "jti_1",
    expiresAt: Math.floor(Date.now() / 1000) + 900,
  };
}

function makeFakePool(rowsFor: (sql: string) => unknown[]): {
  pool: Pool;
  calls: string[];
} {
  const calls: string[] = [];
  const client = {
    query: vi.fn((sql: string) => {
      calls.push(sql);
      if (
        sql === "BEGIN" ||
        sql === "COMMIT" ||
        sql === "ROLLBACK" ||
        sql.startsWith("SELECT set_config")
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      const rows = rowsFor(sql);
      return Promise.resolve({ rows, rowCount: rows.length });
    }),
    release: vi.fn(),
  };
  return { pool: { connect: vi.fn(() => Promise.resolve(client)) } as unknown as Pool, calls };
}

const ENDPOINT = { id: "whe_1", url: "https://example.com/hook", secret: "s", enabled: true };

async function buildApp(deps: WebhookRouteDeps, scopes: Scope[]): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(errorHandlerPlugin);
  app.addHook("onRequest", async (req) => {
    req.principal = principal(scopes);
  });
  await registerWebhookRoutes(app, deps);
  return app;
}

describe("GET /webhooks/:endpoint_id/dead-letters", () => {
  it("lists dead-letters for a known endpoint", async () => {
    const { pool } = makeFakePool((sql) => {
      if (sql.includes("FROM webhook_endpoints")) return [ENDPOINT];
      if (sql.includes("FROM webhook_dead_letters"))
        return [
          {
            id: "wdl_1",
            event_id: "evt_1",
            event_type: "payment_intent.created",
            last_error: "HTTP 500",
            attempt_count: 2,
            created_at: new Date("2026-01-01T00:00:00Z"),
            last_attempt_at: new Date("2026-01-01T00:05:00Z"),
          },
        ];
      return [];
    });
    const app = await buildApp({ pool }, ["audit:read"]);
    const res = await app.inject({ method: "GET", url: "/webhooks/whe_1/dead-letters" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.endpoint_id).toBe("whe_1");
    expect(body.dead_letters[0].attempt_count).toBe(2);
  });

  it("404s for an unknown endpoint (tenant-scoped)", async () => {
    const { pool } = makeFakePool(() => []); // endpoint lookup → empty
    const app = await buildApp({ pool }, ["audit:read"]);
    const res = await app.inject({ method: "GET", url: "/webhooks/whe_x/dead-letters" });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /webhooks/:endpoint_id/replay", () => {
  it("redelivers replayable dead-letters: success clears, failure increments", async () => {
    const { pool, calls } = makeFakePool((sql) => {
      if (sql.includes("FROM webhook_endpoints")) return [ENDPOINT];
      if (sql.includes("attempt_count < $2"))
        return [
          { id: "wdl_a", payload: { id: "evt_a" } },
          { id: "wdl_b", payload: { id: "evt_b" } },
        ];
      return [];
    });
    // First delivery succeeds, second fails.
    const deliver = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, error: "HTTP 503" });
    const app = await buildApp({ pool, deliver }, ["audit:write"]);
    const res = await app.inject({ method: "POST", url: "/webhooks/whe_1/replay" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ attempted: 2, redelivered: 1, still_failing: 1 });
    expect(deliver).toHaveBeenCalledTimes(2);
    // One delete (success) + one update (failure).
    expect(calls.some((s) => s.includes("DELETE FROM webhook_dead_letters WHERE id"))).toBe(true);
    expect(calls.some((s) => s.includes("UPDATE webhook_dead_letters"))).toBe(true);
  });

  it("404s for an unknown endpoint", async () => {
    const { pool } = makeFakePool(() => []);
    const app = await buildApp({ pool }, ["audit:write"]);
    const res = await app.inject({ method: "POST", url: "/webhooks/whe_x/replay" });
    expect(res.statusCode).toBe(404);
  });
});
