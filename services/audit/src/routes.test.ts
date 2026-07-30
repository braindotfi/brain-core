import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { InMemoryAuditEmitter, errorHandlerPlugin, newTenantId } from "@brain/shared";
import type { Pool } from "pg";
import { registerAuditRoutes } from "./routes.js";
import { buildTree, makeProof, verifyProof } from "./merkle.js";
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
    event_type: "assistant_activity",
    severity: "info",
    actor: "user_1",
    actor_display_name: null,
    actor_email: null,
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

  function buildApp(row = eventRow): ReturnType<typeof Fastify> {
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
        if (text.includes("FROM audit_events WHERE id")) return { rows: [row], rowCount: 1 };
        if (text.includes("FROM audit_anchors") && text.includes("period_start <=")) {
          return { rows: [anchorRow], rowCount: 1 };
        }
        if (text.includes("WHERE created_at >=")) return { rows: [row], rowCount: 1 };
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
    expect(body.event.event_type).toBe("assistant_activity");
    expect(body.event.category).toBe("assistant_activity");
    expect(body.event.severity).toBe("info");
    expect(body.event.actor_ref).toMatchObject({
      id: "user_1",
      type: "user",
      lookup: "/v1/members/user_1",
    });
    expect(body.inclusion_proof).toBeTypeOf("object");
    expect(body.inclusion_proof).toHaveProperty("merkle_root");
    expect(body.inclusion_proof).toHaveProperty("merkle_proof");
    expect(body.inclusion_proof.anchor_block).toBe(12345);
    expect(typeof body.inclusion_proof.anchor_tx_hash).toBe("string");
    await app.close();
  });

  it("returns a non-null merkle_root and a verifying proof for an event in an OLDER anchor window (not the newest)", async () => {
    const oldEventHash = Buffer.alloc(32, 3);
    const siblingHash = Buffer.alloc(32, 4);
    const oldEventRow = {
      ...eventRow,
      id: "evt_old",
      event_hash: oldEventHash,
      created_at: new Date("2026-05-20T00:00:00Z"),
    };
    const siblingEventRow = { ...oldEventRow, id: "evt_old_2", event_hash: siblingHash };
    // An OLDER, already-confirmed anchor window that actually contains evt_old
    // -- distinct from anchorRow above, which is the newest window and does not.
    const oldAnchor = {
      id: "anchor_old",
      tenant_id: tenantId,
      merkle_root: Buffer.alloc(32, 0),
      event_count: 2,
      period_start: new Date("2026-05-19T00:00:00Z"),
      period_end: new Date("2026-05-21T00:00:00Z"),
      onchain_tx_hash: Buffer.alloc(32, 8),
      onchain_block_number: "999",
      onchain_status: "confirmed",
      created_at: new Date("2026-05-21T00:00:00Z"),
    };

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
        if (text.includes("FROM audit_events WHERE id")) {
          return { rows: [oldEventRow], rowCount: 1 };
        }
        if (text.includes("FROM audit_anchors") && text.includes("period_start <=")) {
          // findAnchorForEvent: the OLDER window contains evt_old's created_at,
          // the newest window (anchorRow) does not.
          return { rows: [oldAnchor], rowCount: 1 };
        }
        if (text.includes("WHERE created_at >=")) {
          return { rows: [oldEventRow, siblingEventRow], rowCount: 2 };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    const pool = { connect: async () => client } as unknown as Pool;
    const deps: AuditDeps = { pool, audit: new InMemoryAuditEmitter() };
    void registerAuditRoutes(app, deps);

    const res = await app.inject({ method: "GET", url: "/audit/event/evt_old" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.inclusion_proof.merkle_root).toBe("string");
    expect(body.inclusion_proof.merkle_root.length).toBeGreaterThan(0);

    const root = Buffer.from(body.inclusion_proof.merkle_root as string, "hex");
    const proof = (body.inclusion_proof.merkle_proof as string[]).map((p) => Buffer.from(p, "hex"));
    expect(verifyProof(root, oldEventHash, proof)).toBe(true);
    await app.close();
  });

  it("routes agent actor lookup refs to the runtime execution agent endpoint", async () => {
    const agentId = "agent_01KYN4M0K0X9G4M27ZB8E8NSQS";
    const app = buildApp({ ...eventRow, id: "evt_agent", actor: agentId });
    const res = await app.inject({ method: "GET", url: "/audit/event/evt_agent" });
    expect(res.statusCode).toBe(200);
    expect(res.json().event.actor_ref).toMatchObject({
      id: agentId,
      type: "agent",
      lookup: `/v1/execution/agents/${agentId}`,
    });
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

describe("POST /audit/export (declared stub)", () => {
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

  it("rejects a bad format with 400, not the 501 stub response", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/audit/export",
      payload: { format: "xml" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("request_body_invalid");
    await app.close();
  });

  it("returns 501 for a valid request, naming the working alternative", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/audit/export",
      payload: { format: "jsonl" },
    });
    expect(res.statusCode).toBe(501);
    expect(res.json().error.message).toContain("/v1/tenants/{tenant_id}/export");
    await app.close();
  });
});

describe("POST /audit/anchor/publish cooldown (durable, DB-derived)", () => {
  const tenantId = newTenantId();

  function buildApp(opts: { lastAnchorAt: Date | null; hasWindowEvents: boolean }): {
    app: ReturnType<typeof Fastify>;
    queries: string[];
  } {
    const app = Fastify();
    void app.register(errorHandlerPlugin);
    app.addHook("onRequest", async (req) => {
      (req as unknown as { principal: unknown }).principal = {
        tenantId,
        id: "user_1",
        type: "user",
        scopes: ["audit:admin"],
      };
    });
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (text: string) => {
        queries.push(text.trim().split("\n")[0]!.trim());
        if (text.includes("max(created_at)")) {
          return { rows: [{ last_at: opts.lastAnchorAt }], rowCount: 1 };
        }
        if (text.includes("FROM audit_events") && text.includes("created_at >=")) {
          return {
            rows: opts.hasWindowEvents
              ? [
                  {
                    id: "evt_1",
                    event_hash: Buffer.alloc(32, 1),
                    created_at: new Date(),
                  },
                ]
              : [],
            rowCount: opts.hasWindowEvents ? 1 : 0,
          };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    const pool = { connect: async () => client } as unknown as Pool;
    const broadcaster = vi.fn(async () => ({
      txHash: Buffer.alloc(32, 2),
      blockNumber: 1n,
      status: "confirmed" as const,
    }));
    const deps: AuditDeps = { pool, audit: new InMemoryAuditEmitter(), broadcaster };
    void registerAuditRoutes(app, deps);
    return { app, queries };
  }

  it("returns rate_limited, driven by the existing anchor row, when the last anchor is inside the cooldown window", async () => {
    const { app, queries } = buildApp({
      lastAnchorAt: new Date(Date.now() - 10_000), // 10s ago, cooldown is 60s
      hasWindowEvents: false,
    });
    const res = await app.inject({ method: "POST", url: "/audit/anchor/publish", payload: {} });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe("rate_limited");
    // Cooldown is derived from the anchor row itself, not an in-process Map.
    expect(queries.some((q) => q.includes("max(created_at)"))).toBe(true);
    await app.close();
  });

  it("lets a tenant with no anchors through (no cooldown row means no cooldown)", async () => {
    const { app } = buildApp({ lastAnchorAt: null, hasWindowEvents: false });
    const res = await app.inject({ method: "POST", url: "/audit/anchor/publish", payload: {} });
    // Not rate-limited -- it reaches the real "no events to anchor" outcome,
    // proving the cooldown check let the request through.
    expect(res.statusCode).not.toBe(429);
    expect(res.json().error.code).toBe("audit_no_events");
    await app.close();
  });
});
