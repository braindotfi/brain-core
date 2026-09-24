import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { errorHandlerPlugin, newTenantId } from "@brain/shared";
import { registerIntegrationRoutes } from "./routes.js";

const TENANT = newTenantId();

function makePool(): Pool {
  const client = {
    query: vi.fn((sql: string, values: unknown[] = []) => {
      if (
        sql === "BEGIN" ||
        sql === "COMMIT" ||
        sql === "ROLLBACK" ||
        sql.startsWith("SELECT set_config")
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (sql.includes("INSERT INTO tenant_integrations")) {
        return Promise.resolve({
          rows: [
            {
              tenant_id: values[0],
              adapter_kind: values[1],
              provider: values[2],
              config: JSON.parse(values[3] as string),
              enabled: values[4],
              created_at: new Date("2026-09-21T00:00:00Z"),
              updated_at: new Date("2026-09-21T00:00:00Z"),
            },
          ],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    }),
    release: vi.fn(),
  };
  return { connect: vi.fn(() => Promise.resolve(client)) } as unknown as Pool;
}

async function buildApp(env: Record<string, string | undefined>) {
  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  app.addHook("preHandler", async (request) => {
    request.principal = {
      id: "user_1",
      type: "user",
      tenantId: TENANT,
      scopes: ["execution:read", "execution:admin"],
      tokenId: "tok_1",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
  });
  await registerIntegrationRoutes(app, { pool: makePool(), env });
  return app;
}

describe("tenant integration routes", () => {
  it("rejects enabled providers when required env is missing", async () => {
    const app = await buildApp({});
    try {
      const response = await app.inject({
        method: "PUT",
        url: "/tenant/integrations/ofac",
        payload: { provider: "comply_advantage", enabled: true },
      });
      expect(response.statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });

  it("stores enabled provider config without echoing secrets", async () => {
    const app = await buildApp({
      COMPLY_ADVANTAGE_API_KEY: "key",
      COMPLY_ADVANTAGE_ENDPOINT: "https://example.test",
    });
    try {
      const response = await app.inject({
        method: "PUT",
        url: "/tenant/integrations/ofac",
        payload: {
          provider: "comply_advantage",
          enabled: true,
          config: { tenant_list: "uae", secret: "hidden" },
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        adapter_kind: "ofac",
        provider: "comply_advantage",
        config_keys: ["tenant_list", "secret"],
      });
      expect(JSON.stringify(response.json())).not.toContain("hidden");
    } finally {
      await app.close();
    }
  });
});
