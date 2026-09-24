import { createHmac } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { errorHandlerPlugin, newTenantId } from "@brain/shared";
import type { Pool } from "pg";
import { NylasAdapter, decodeState } from "./adapter.js";
import { NylasCollectionsEmailSender } from "./email-sender.js";
import { registerNylasRoutes } from "./routes.js";
import { NylasGrantStore } from "./store.js";
import { handleNylasWebhookEvent, verifyNylasSignature } from "./webhook.js";

const TENANT = newTenantId();

describe("Nylas integration", () => {
  it("round-trips mock OAuth exchange through the routes", async () => {
    const db = new FakeNylasDb();
    const adapter = mockAdapter();
    const app = await appFor(db.pool, adapter);

    try {
      const connect = await app.inject({ method: "POST", url: "/integrations/nylas/connect" });
      expect(connect.statusCode).toBe(200);
      const authUrl = new URL((connect.json() as { authUrl: string }).authUrl);
      expect(authUrl.pathname).toBe("/integrations/nylas/callback");
      expect(decodeState(authUrl.searchParams.get("state") ?? "").tenantId).toBe(TENANT);

      const callback = await app.inject({
        method: "GET",
        url: `${authUrl.pathname}${authUrl.search}`,
      });

      expect(callback.statusCode).toBe(302);
      expect(callback.headers.location).toBe("/settings/sources?connected=email");
      expect(db.grant).toMatchObject({
        tenant_id: TENANT,
        provider: "gmail",
        email: "you@example.com",
        disconnected_at: null,
      });
    } finally {
      await app.close();
    }
  });

  it("sends email in mock mode and advances proposal delivery state", async () => {
    const db = new FakeNylasDb();
    db.grant = {
      tenant_id: TENANT,
      grant_id: "mock_grant",
      provider: "gmail",
      email: "you@example.com",
      scope: ["email.send"],
      connected_at: new Date("2026-09-24T00:00:00.000Z"),
      disconnected_at: null,
    };
    const sender = new NylasCollectionsEmailSender(db.pool, mockAdapter());

    const sent = await sender.send(ctx(), {
      proposalId: "prop_collections",
      to: ["customer@example.com"],
      subject: "Invoice reminder",
      body: "Hello",
    });

    expect(sent.messageId).toMatch(/^mock_msg_/);
    expect(db.proposal).toMatchObject({
      sent_message_id: sent.messageId,
      sent_thread_id: sent.threadId,
      delivery_status: "sent",
    });
  });

  it("verifies webhook signatures", () => {
    const body = Buffer.from(JSON.stringify({ type: "message.created" }));
    const secret = "whsec_test";
    const signature = createHmac("sha256", secret).update(body).digest("hex");

    expect(verifyNylasSignature(body, signature, secret)).toBe(true);
    expect(verifyNylasSignature(body, "00", secret)).toBe(false);
  });

  it("marks a matching proposal as replied on message.created", async () => {
    const db = new FakeNylasDb();
    db.grant = {
      tenant_id: TENANT,
      grant_id: "grant_123",
      provider: "gmail",
      email: "you@example.com",
      scope: ["email.send"],
      connected_at: new Date("2026-09-24T00:00:00.000Z"),
      disconnected_at: null,
    };
    db.proposal.sent_thread_id = "thread_123";

    await handleNylasWebhookEvent(db.pool, {
      type: "message.created",
      data: { grant_id: "grant_123", thread_id: "thread_123", id: "msg_reply" },
    });

    expect(db.proposal).toMatchObject({
      delivery_status: "replied",
      sent_message_id: "msg_reply",
    });
  });

  it("retries sendEmail twice on 429", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(Response.json({ data: { id: "msg_1", thread_id: "thread_1" } }));
    const adapter = new NylasAdapter({
      mode: "real",
      apiUri: "https://api.us.nylas.com",
      apiKey: "key",
      redirectUri: "http://localhost/callback",
      fetchImpl,
    });

    const sent = await adapter.sendEmail({
      grantId: "grant_1",
      to: ["customer@example.com"],
      subject: "Reminder",
      body: "Hello",
      replyTo: "you@example.com",
    });

    expect(sent).toEqual({ messageId: "msg_1", threadId: "thread_1" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("disconnects the previous grant when a tenant connects again", async () => {
    const db = new FakeNylasDb();
    db.grant = {
      tenant_id: TENANT,
      grant_id: "old_grant",
      provider: "gmail",
      email: "old@example.com",
      scope: ["email.send"],
      connected_at: new Date("2026-09-24T00:00:00.000Z"),
      disconnected_at: null,
    };
    const adapter = mockAdapter();
    const disconnect = vi.spyOn(adapter, "disconnect");
    const store = new NylasGrantStore(db.pool, adapter);

    await store.upsert(ctx(), {
      grantId: "new_grant",
      provider: "outlook",
      email: "new@example.com",
      scope: ["email.send"],
    });

    expect(disconnect).toHaveBeenCalledWith({ grantId: "old_grant" });
    expect(db.grant).toMatchObject({ grant_id: "new_grant", provider: "outlook" });
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

function ctx() {
  return {
    tenantId: TENANT,
    actor: "user_1",
    requestId: "req_1",
    principalType: "user" as const,
    scopes: ["execution:read", "execution:admin"],
  };
}

interface FakeGrant {
  tenant_id: string;
  grant_id: string;
  provider: "gmail" | "outlook" | "imap";
  email: string;
  scope: string[];
  connected_at: Date;
  disconnected_at: Date | null;
}

class FakeNylasDb {
  public grant: FakeGrant | null = null;
  public proposal = {
    id: "prop_collections",
    sent_message_id: null as string | null,
    sent_thread_id: null as string | null,
    delivery_status: null as string | null,
    sent_at: null as Date | null,
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
    if (sql.includes("FROM nylas_grants") && sql.includes("grant_id = $1")) {
      const grant = this.grant;
      const matched = grant !== null && grant.grant_id === values[0];
      return {
        rows: matched ? [{ tenant_id: grant.tenant_id }] : [],
        rowCount: matched ? 1 : 0,
      };
    }
    if (sql.includes("FROM nylas_grants")) {
      return {
        rows: this.grant !== null && this.grant.disconnected_at === null ? [this.grant] : [],
        rowCount: this.grant !== null && this.grant.disconnected_at === null ? 1 : 0,
      };
    }
    if (sql.includes("INSERT INTO nylas_grants")) {
      this.grant = {
        tenant_id: TENANT,
        grant_id: String(values[0]),
        provider: values[1] as FakeGrant["provider"],
        email: String(values[2]),
        scope: values[3] as string[],
        connected_at: new Date("2026-09-24T00:00:00.000Z"),
        disconnected_at: null,
      };
      return { rows: [this.grant], rowCount: 1 };
    }
    if (sql.includes("UPDATE nylas_grants")) {
      if (this.grant !== null) this.grant.disconnected_at = new Date("2026-09-24T00:01:00.000Z");
      return { rows: [], rowCount: this.grant === null ? 0 : 1 };
    }
    if (sql.includes("UPDATE proposals") && sql.includes("delivery_status = 'sent'")) {
      this.proposal.sent_message_id = String(values[1]);
      this.proposal.sent_thread_id = String(values[2]);
      this.proposal.delivery_status = "sent";
      this.proposal.sent_at = new Date("2026-09-24T00:02:00.000Z");
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE proposals")) {
      this.proposal.delivery_status = String(values[0]);
      if (values.includes("thread_123")) this.proposal.sent_thread_id = "thread_123";
      if (values.includes("msg_reply")) this.proposal.sent_message_id = "msg_reply";
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
}
