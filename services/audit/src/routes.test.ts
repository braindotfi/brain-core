import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { InMemoryAuditEmitter, errorHandlerPlugin, newTenantId } from "@brain/shared";
import type { Pool } from "pg";
import { registerAuditRoutes } from "./routes.js";
import { buildTree, makeProof } from "./merkle.js";
import type { AuditDeps } from "./deps.js";

async function buildApp(): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify();
  const deps: AuditDeps = {
    // /audit/verify is a pure, public (skipAuth) endpoint — it never touches
    // the pool, so a placeholder is fine for this test.
    pool: {} as unknown as Pool,
    audit: new InMemoryAuditEmitter(),
  };
  await registerAuditRoutes(app, deps);
  return app;
}

describe("POST /audit/verify", () => {
  const leaves = [1, 2, 3, 4].map((n) => Buffer.alloc(32, n));
  const tree = buildTree(leaves);

  it("verifies a valid inclusion proof (spec shape)", async () => {
    const app = await buildApp();
    const proof = makeProof(tree, 1).map((b) => b.toString("hex"));
    const res = await app.inject({
      method: "POST",
      url: "/audit/verify",
      payload: {
        event_hash: leaves[1]!.toString("hex"),
        merkle_proof: proof,
        merkle_root: tree.root.toString("hex"),
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ verified: true, onchain_block: null });
    await app.close();
  });

  it("returns verified:false for a proof against the wrong root", async () => {
    const app = await buildApp();
    const proof = makeProof(tree, 1).map((b) => b.toString("hex"));
    const res = await app.inject({
      method: "POST",
      url: "/audit/verify",
      payload: {
        event_hash: leaves[1]!.toString("hex"),
        merkle_proof: proof,
        merkle_root: "f".repeat(64),
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().verified).toBe(false);
    await app.close();
  });
});

describe("GET /audit/event/:id inclusion_proof shape", () => {
  const tenantId = newTenantId();
  const eventHash = Buffer.alloc(32, 7);
  const eventRow = {
    id: "evt_1",
    layer: "ledger",
    actor: "user_1",
    action: "ledger.account.created",
    inputs: {},
    outputs: {},
    policy_version: null,
    event_hash: eventHash,
    prev_event_hash: null,
    created_at: new Date("2026-05-23T00:00:00Z"),
  };
  const anchorRow = {
    id: "anchor_1",
    tenant_id: tenantId,
    merkle_root: eventHash,
    event_count: 1,
    period_start: new Date("2026-05-22T00:00:00Z"),
    period_end: new Date("2026-05-23T12:00:00Z"),
    onchain_tx_hash: Buffer.alloc(32, 9),
    onchain_block_number: "12345",
    onchain_status: "confirmed",
    created_at: new Date("2026-05-23T12:00:00Z"),
  };

  function buildApp(): ReturnType<typeof Fastify> {
    const app = Fastify();
    app.addHook("onRequest", async (req) => {
      (req as unknown as { principal: unknown }).principal = {
        tenantId,
        id: "user_1",
        type: "user",
        scopes: ["audit:read"],
      };
    });
    const client = {
      query: vi.fn(async (text: string) => {
        if (text.includes("FROM audit_events WHERE id")) return { rows: [eventRow], rowCount: 1 };
        if (text.includes("FROM audit_anchors ORDER BY period_end")) {
          return { rows: [anchorRow], rowCount: 1 };
        }
        if (text.includes("WHERE created_at >=")) return { rows: [eventRow], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    const pool = { connect: async () => client } as unknown as Pool;
    const deps: AuditDeps = { pool, audit: new InMemoryAuditEmitter() };
    void registerAuditRoutes(app, deps);
    return app;
  }

  it("returns a single nested inclusion_proof object (spec + SDK shape)", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/audit/event/evt_1" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.event.id).toBe("evt_1");
    expect(body.inclusion_proof).toBeTypeOf("object");
    expect(body.inclusion_proof).toHaveProperty("merkle_root");
    expect(body.inclusion_proof).toHaveProperty("merkle_proof");
    expect(body.inclusion_proof.anchor_block).toBe(12345);
    expect(typeof body.inclusion_proof.anchor_tx_hash).toBe("string");
    await app.close();
  });
});

describe("GET /audit/events query-param validation (F-2)", () => {
  const tenantId = newTenantId();

  function buildApp(): ReturnType<typeof Fastify> {
    const app = Fastify();
    void app.register(errorHandlerPlugin);
    app.addHook("onRequest", async (req) => {
      (req as unknown as { principal: unknown }).principal = {
        tenantId,
        id: "user_1",
        type: "user",
        scopes: ["audit:read"],
      };
    });
    const client = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
      release: vi.fn(),
    };
    const pool = { connect: async () => client } as unknown as Pool;
    void registerAuditRoutes(app, { pool, audit: new InMemoryAuditEmitter() });
    return app;
  }

  it("rejects a non-numeric or negative limit with 400, never a pg 500", async () => {
    const app = buildApp();
    for (const bad of ["abc", "-5", "0", "3.5"]) {
      const res = await app.inject({ method: "GET", url: `/audit/events?limit=${bad}` });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("request_params_invalid");
    }
    await app.close();
  });

  it("rejects a garbage since/until timestamp with 400", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/audit/events?since=garbage" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("request_params_invalid");
    await app.close();
  });

  it("still accepts a valid limit and clamps large values", async () => {
    const app = buildApp();
    const ok = await app.inject({ method: "GET", url: "/audit/events?limit=50" });
    expect(ok.statusCode).toBe(200);
    const clamped = await app.inject({ method: "GET", url: "/audit/events?limit=9999" });
    expect(clamped.statusCode).toBe(200); // capped at 500, not rejected
    await app.close();
  });
});
