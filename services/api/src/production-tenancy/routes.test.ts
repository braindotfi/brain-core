import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { errorHandlerPlugin, newTenantId } from "@brain/shared";
import { registerProductionTenancyRoutes } from "./routes.js";

const platformSecret = "platform-secret";

interface QueryCall {
  sql: string;
  values?: unknown[];
}

function memberRow(overrides: Record<string, unknown> = {}) {
  return {
    tenant_id: newTenantId(),
    id: "user_bootstrap",
    email: "founder@example.com",
    display_name: "Founder",
    role: "admin",
    status: "active",
    active: true,
    approval_domains: ["ap", "ar", "treasury", "payroll", "reconciliation"],
    per_item_limit_cents: "9223372036854775807",
    requires_second_approver_above_cents: null,
    ...overrides,
  };
}

function appPool(member = memberRow()) {
  const calls: QueryCall[] = [];
  const client = {
    query: vi.fn((sql: string, values?: unknown[]) => {
      calls.push(values === undefined ? { sql } : { sql, values });
      if (
        sql === "BEGIN" ||
        sql === "COMMIT" ||
        sql === "ROLLBACK" ||
        sql.startsWith("SELECT set_config")
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (sql.includes("FROM members") && sql.includes("WHERE id = $1")) {
        return Promise.resolve({ rows: [member], rowCount: 1 });
      }
      if (sql.startsWith("UPDATE members")) {
        return Promise.resolve({
          rows: [{ ...member, status: "active", active: true }],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    }),
    release: vi.fn(),
  };
  return {
    calls,
    pool: { connect: vi.fn(() => Promise.resolve(client)) },
  };
}

function resolverPool(rows: unknown[] = []) {
  return {
    query: vi.fn(() => Promise.resolve({ rows, rowCount: rows.length })),
  };
}

async function build(opts: { appRows?: unknown[]; resolverRows?: unknown[] } = {}) {
  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  const appDb = appPool(opts.appRows?.[0] === undefined ? memberRow() : (opts.appRows[0] as never));
  const resolver = resolverPool(opts.resolverRows ?? []);
  const audit = { emit: vi.fn(async () => ({ id: "audit_1" })) };
  const signer = { sign: vi.fn(async () => "access-token") };
  await registerProductionTenancyRoutes(app, {
    pool: appDb.pool as never,
    resolverPool: resolver as never,
    audit: audit as never,
    signer: signer as never,
    platformSecret,
  });
  return { app, appDb, resolver, audit, signer };
}

describe("production tenancy routes", () => {
  it("creates a production tenant with one bootstrap admin and a session", async () => {
    const { app, appDb, signer } = await build();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/tenants",
        headers: { "x-platform-service-auth": platformSecret },
        payload: {
          company_name: "Acme",
          founder: { email: "founder@example.com", display_name: "Founder" },
          founder_external_ref: "platform-user-1",
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.session.token).toBe("access-token");
      expect(body.session.refresh_token).toBeTypeOf("string");
      expect(body.member.role).toBe("admin");
      expect(
        appDb.calls.some((c) =>
          c.sql.includes("INSERT INTO tenants (id, kind, sandbox, created_via)"),
        ),
      ).toBe(true);
      expect(
        appDb.calls.some(
          (c) =>
            c.sql.includes("INSERT INTO member_identity_links") && c.sql.includes("'platform'"),
        ),
      ).toBe(true);
      expect(signer.sign).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "user",
          scopes: expect.arrayContaining(["execution:admin"]),
        }),
      );
    } finally {
      await app.close();
    }
  });

  it("rejects demo-fence auth on production tenant creation", async () => {
    const { app } = await build();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/tenants",
        headers: {
          "x-platform-service-auth": platformSecret,
          "x-demo-provision-auth": "demo-secret",
        },
        payload: {
          founder: { email: "founder@example.com" },
          founder_external_ref: "platform-user-1",
        },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().reason).toBe("platform_service_credential_required");
    } finally {
      await app.close();
    }
  });

  it("does not auto-create a session for an unlinked platform identity", async () => {
    const { app, appDb } = await build({ resolverRows: [] });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/sessions",
        headers: { "x-platform-service-auth": platformSecret },
        payload: { external_ref: "missing-user" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().reason).toBe("session_identity_unlinked");
      expect(appDb.calls.some((c) => c.sql.includes("INSERT INTO session_refresh_tokens"))).toBe(
        false,
      );
    } finally {
      await app.close();
    }
  });

  it("returns the exact invalid reason for a bad invite token", async () => {
    const { app, appDb } = await build({ resolverRows: [] });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/invites/consume",
        headers: { "x-platform-service-auth": platformSecret },
        payload: { invite_token: "bad-token", external_ref: "platform-user-2" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().reason).toBe("invite_invalid");
      expect(appDb.calls.some((c) => c.sql.includes("member_identity_links"))).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("revokes a refresh family when a rotated token is reused", async () => {
    const tenantId = newTenantId();
    const refresh = {
      tenant_id: tenantId,
      member_id: "user_1",
      token_hash: "unused",
      family_id: "token_family",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      rotated_at: new Date().toISOString(),
      revoked_at: null,
    };
    const { app, appDb } = await build({ resolverRows: [refresh] });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/sessions/refresh",
        payload: { refresh_token: "any-token" },
      });
      expect(res.statusCode).toBe(401);
      expect(
        appDb.calls.some(
          (c) => c.sql.includes("UPDATE session_refresh_tokens") && c.sql.includes("family_id"),
        ),
      ).toBe(true);
    } finally {
      await app.close();
    }
  });
});
