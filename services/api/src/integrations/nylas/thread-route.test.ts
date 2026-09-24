import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { errorHandlerPlugin, newTenantId } from "@brain/shared";
import type { Pool } from "pg";
import { NylasAdapter } from "./adapter.js";
import { registerNylasRoutes } from "./routes.js";

const TENANT = newTenantId();

describe("GET /proposals/:id/thread", () => {
  it("returns full thread messages with direction assigned", async () => {
    const db = new FakeThreadDb();
    db.proposal = {
      id: "prop_sent",
      sent_thread_id: "mock_thread_123",
      delivery_status: "sent",
    };
    const app = await appFor(db.pool, mockAdapter());

    try {
      const response = await app.inject({ method: "GET", url: "/proposals/prop_sent/thread" });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        thread_id: "mock_thread_123",
        messages: [
          {
            id: "mock_msg_outbound",
            from: { name: "You", email: "you@example.com" },
            to: [{ name: "Customer", email: "customer@example.com" }],
            subject: "Invoice reminder",
            snippet: "Following up on the open invoice.",
            body_html: "<p>Following up on the open invoice.</p>",
            body_text: "Following up on the open invoice.",
            received_at: "2026-09-24T08:00:00.000Z",
            direction: "outbound",
          },
          {
            id: "mock_msg_inbound",
            from: { name: "Customer", email: "customer@example.com" },
            to: [{ name: "You", email: "you@example.com" }],
            subject: "Re: Invoice reminder",
            snippet: "We will send payment today.",
            body_html: "<p>We will send payment today.</p>",
            body_text: "We will send payment today.",
            received_at: "2026-09-24T09:00:00.000Z",
            direction: "inbound",
          },
        ],
      });
    } finally {
      await app.close();
    }
  });

  it("returns 404 for an unknown proposal", async () => {
    const db = new FakeThreadDb();
    const app = await appFor(db.pool, mockAdapter());

    try {
      const response = await app.inject({ method: "GET", url: "/proposals/missing/thread" });

      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe("execution_proposal_not_found");
    } finally {
      await app.close();
    }
  });

  it("returns 409 when the proposal has not sent email", async () => {
    const db = new FakeThreadDb();
    db.proposal = {
      id: "prop_unsent",
      sent_thread_id: null,
      delivery_status: null,
    };
    const app = await appFor(db.pool, mockAdapter());

    try {
      const response = await app.inject({ method: "GET", url: "/proposals/prop_unsent/thread" });

      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe("execution_proposal_invalid_state");
    } finally {
      await app.close();
    }
  });

  it("returns 424 when the tenant grant is disconnected", async () => {
    const db = new FakeThreadDb();
    db.proposal = {
      id: "prop_sent",
      sent_thread_id: "thread_123",
      delivery_status: "sent",
    };
    db.grant = {
      grant_id: "grant_123",
      email: "you@example.com",
      disconnected_at: new Date("2026-09-24T10:00:00.000Z"),
    };
    const app = await appFor(db.pool, mockAdapter());

    try {
      const response = await app.inject({ method: "GET", url: "/proposals/prop_sent/thread" });

      expect(response.statusCode).toBe(424);
      expect(response.json().error.code).toBe("dependency_unavailable");
    } finally {
      await app.close();
    }
  });

  it("surfaces Nylas 429 with retry-after", async () => {
    const db = new FakeThreadDb();
    db.proposal = {
      id: "prop_sent",
      sent_thread_id: "thread_123",
      delivery_status: "sent",
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "17" },
        }),
      );
    const app = await appFor(
      db.pool,
      new NylasAdapter({
        mode: "real",
        apiUri: "https://api.us.nylas.com",
        apiKey: "key",
        redirectUri: "http://localhost/integrations/nylas/callback",
        fetchImpl,
      }),
    );

    try {
      const response = await app.inject({ method: "GET", url: "/proposals/prop_sent/thread" });

      expect(response.statusCode).toBe(429);
      expect(response.headers["retry-after"]).toBe("17");
      expect(response.json().error.code).toBe("rate_limit_exceeded");
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    } finally {
      await app.close();
    }
  });
});

async function appFor(pool: Pool, adapter: NylasAdapter) {
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
  await registerNylasRoutes(app, {
    pool,
    adapter,
    redirectUri: "http://localhost/integrations/nylas/callback",
    webhookSecret: "whsec_test",
  });
  return app;
}

function mockAdapter(): NylasAdapter {
  return new NylasAdapter({
    mode: "mock",
    apiUri: "https://api.us.nylas.com",
    redirectUri: "http://localhost/integrations/nylas/callback",
  });
}

interface FakeProposal {
  id: string;
  sent_thread_id: string | null;
  delivery_status: string | null;
}

interface FakeGrant {
  grant_id: string;
  email: string;
  disconnected_at: Date | null;
}

class FakeThreadDb {
  public proposal: FakeProposal | null = null;
  public grant: FakeGrant | null = {
    grant_id: "mock_grant",
    email: "you@example.com",
    disconnected_at: null,
  };

  public readonly pool = {
    connect: async () => ({
      query: async (sql: string, values: unknown[] = []) => this.query(sql, values),
      release: () => undefined,
    }),
  } as unknown as Pool;

  private async query(sql: string, values: unknown[]) {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("SELECT set_config")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("FROM proposals")) {
      const id = String(values[0]);
      const proposal = this.proposal;
      return {
        rows: proposal !== null && proposal.id === id ? [proposal] : [],
        rowCount: proposal !== null && proposal.id === id ? 1 : 0,
      };
    }
    if (sql.includes("FROM nylas_grants")) {
      return {
        rows: this.grant !== null ? [this.grant] : [],
        rowCount: this.grant !== null ? 1 : 0,
      };
    }
    return { rows: [], rowCount: 0 };
  }
}
