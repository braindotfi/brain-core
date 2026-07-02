import { describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyRequest } from "fastify";
import {
  InMemoryAuditEmitter,
  errorHandlerPlugin,
  newTenantId,
  type Principal,
} from "@brain/shared";
import { registerMemberRoutes } from "./routes.js";

const tenantId = newTenantId();
const tokenId = "tok_members";

function principal(id: string): Principal {
  return {
    id,
    type: "user",
    tenantId,
    scopes: ["execution:admin", "execution:read"] as Principal["scopes"],
    tokenId,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

function row(id: string, role: "admin" | "approver" | "viewer", active = true) {
  return {
    tenant_id: tenantId,
    id,
    email: `${id}@example.com`,
    display_name: id,
    role,
    active,
    approval_domains: ["ap"],
    per_item_limit_cents: "10000",
    requires_second_approver_above_cents: null,
  };
}

async function buildApp(opts: {
  principal: Principal;
  members: Record<string, ReturnType<typeof row>>;
  activeAdmins: number;
}) {
  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  app.addHook("preHandler", async (request: FastifyRequest) => {
    request.principal = opts.principal;
  });
  const client = {
    query: vi.fn((sql: string, values?: unknown[]) => {
      if (
        sql === "BEGIN" ||
        sql === "COMMIT" ||
        sql === "ROLLBACK" ||
        sql.startsWith("SELECT set_config")
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (sql.includes("count(*)::text AS count")) {
        return Promise.resolve({ rows: [{ count: String(opts.activeAdmins) }], rowCount: 1 });
      }
      if (sql.includes("FROM members") && sql.includes("WHERE id = $1")) {
        const id = String(values?.[0]);
        const found = opts.members[id];
        return Promise.resolve({ rows: found === undefined ? [] : [found], rowCount: 1 });
      }
      if (sql.startsWith("UPDATE members")) {
        const id = String(values?.[values.length - 1]);
        const found = opts.members[id];
        return Promise.resolve({ rows: found === undefined ? [] : [found], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    }),
    release: vi.fn(),
  };
  const pool = { connect: vi.fn(() => Promise.resolve(client)) };
  const audit = new InMemoryAuditEmitter();
  await registerMemberRoutes(app, { pool: pool as never, audit });
  return { app, audit };
}

describe("member routes", () => {
  it("rejects an approver attempting to patch a member", async () => {
    const { app } = await buildApp({
      principal: principal("usr_approver"),
      members: { usr_approver: row("usr_approver", "approver") },
      activeAdmins: 1,
    });
    try {
      const res = await app.inject({
        method: "PATCH",
        url: "/members/usr_target",
        payload: { role: "viewer" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("auth_scope_insufficient");
    } finally {
      await app.close();
    }
  });

  it("protects the last active admin from deactivation", async () => {
    const { app } = await buildApp({
      principal: principal("usr_admin"),
      members: { usr_admin: row("usr_admin", "admin") },
      activeAdmins: 1,
    });
    try {
      const res = await app.inject({ method: "DELETE", url: "/members/usr_admin" });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.details.reason).toBe("last_admin_protected");
    } finally {
      await app.close();
    }
  });
});
