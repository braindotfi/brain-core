import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  errorHandlerPlugin,
  newCounterpartyId,
  newDocumentId,
  newTenantId,
  requestIdPlugin,
  type Principal,
  type Scope,
} from "@brain/shared";
import type { Pool } from "pg";
import { registerEvidenceResolveRoutes } from "./routes.js";

const TENANT = newTenantId();
const COUNTERPARTY = newCounterpartyId();
const DOCUMENT = newDocumentId();

function principal(scopes: Scope[] = ["execution:read"]): Principal {
  return {
    id: "user_01TEST0000000000000000000",
    type: "user",
    tenantId: TENANT,
    scopes,
    tokenId: "tok_01TEST0000000000000000000",
    expiresAt: Math.floor(Date.now() / 1000) + 900,
  };
}

async function buildApp(pool: Pool, p: Principal = principal()): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(requestIdPlugin);
  await app.register(errorHandlerPlugin);
  app.addHook("preHandler", async (request) => {
    request.principal = p;
  });
  await registerEvidenceResolveRoutes(app, { pool });
  return app;
}

function fakePool(): Pool {
  let tenant: string | null = null;
  const client = {
    query: vi.fn(async (sql: string, values: unknown[] = []) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (sql.startsWith("SELECT set_config")) {
        tenant = values[0] as string;
        return { rows: [], rowCount: 0 };
      }
      if (tenant === null) throw new Error("tenant scope was not set");
      if (sql.includes("FROM ledger_counterparties") && values[0] === COUNTERPARTY) {
        return {
          rows: [
            {
              id: COUNTERPARTY,
              owner_id: TENANT,
              name: "Acme",
              normalized_name: "acme",
              type: "vendor",
              risk_level: null,
              verified_status: "unverified",
              aliases: [],
              linked_accounts: [],
              agent_id: null,
              onchain_address: null,
              metadata: {},
              source_ids: [],
              evidence_ids: [],
              provenance: "human_confirmed",
              confidence: 1,
              created_at: new Date(),
              updated_at: new Date(),
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
  return { connect: async () => client } as unknown as Pool;
}

describe("POST /evidence/resolve", () => {
  it("resolves supported refs and returns unsupported kinds explicitly", async () => {
    const app = await buildApp(fakePool());
    try {
      const res = await app.inject({
        method: "POST",
        url: "/evidence/resolve",
        payload: {
          refs: [
            { kind: "counterparty", ref: COUNTERPARTY },
            { kind: "document", ref: DOCUMENT },
          ],
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().results).toEqual([
        {
          kind: "counterparty",
          ref: COUNTERPARTY,
          resolvable: true,
          not_found: false,
          summary: "Acme (vendor)",
          deep_link: `/ledger/counterparties/${COUNTERPARTY}`,
        },
        {
          kind: "document",
          ref: DOCUMENT,
          resolvable: false,
          not_found: false,
          summary: null,
          deep_link: null,
          reason: "unsupported_kind",
        },
      ]);
    } finally {
      await app.close();
    }
  });

  it("requires execution read scope before resolving", async () => {
    const app = await buildApp(fakePool(), principal([]));
    try {
      const res = await app.inject({
        method: "POST",
        url: "/evidence/resolve",
        payload: { refs: [{ kind: "counterparty", ref: COUNTERPARTY }] },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("auth_scope_insufficient");
    } finally {
      await app.close();
    }
  });

  it("caps batch length", async () => {
    const app = await buildApp(fakePool());
    try {
      const res = await app.inject({
        method: "POST",
        url: "/evidence/resolve",
        payload: {
          refs: Array.from({ length: 51 }, () => ({ kind: "document", ref: DOCUMENT })),
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("request_body_invalid");
    } finally {
      await app.close();
    }
  });
});
