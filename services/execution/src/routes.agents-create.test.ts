import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  computeAgentScopeHash,
  errorHandlerPlugin,
  idempotencyPlugin,
  InMemoryIdempotencyStore,
  newAgentId,
  newTenantId,
  requestIdPlugin,
  type Principal,
  type Scope,
} from "@brain/shared";
import { scopesForAgentRole } from "@brain/internal-agents";
import type { Pool } from "pg";
import type { ExecutionDeps } from "./deps.js";
import { RailRegistry } from "./rails/stubs.js";
import { registerExecutionRoutes } from "./routes.js";

const TENANT = newTenantId();
const AUTH_AGENT = newAgentId();

function principalWithScopes(scopes: Scope[]): Principal {
  return {
    id: AUTH_AGENT,
    type: "agent",
    tenantId: TENANT,
    scopes,
    tokenId: "tok_01TEST0000000000000000000",
    expiresAt: Math.floor(Date.now() / 1000) + 900,
  };
}

/** Mirrors routes.agents-register.test.ts: a pool whose withTenantScope-driven
 *  client answers INSERT INTO agents by echoing the inserted row back
 *  (RETURNING *), close enough to repository.insertAgent for route-level
 *  assertions. */
function agentInsertingDeps(): ExecutionDeps {
  const client = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (sql.startsWith("SELECT set_config")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("INSERT INTO agents")) {
        return {
          rows: [
            {
              id: values[0],
              tenant_id: values[1],
              kind: values[2],
              role: values[3],
              display_name: values[4],
              scope_hash: values[5],
              onchain_address: values[6],
              state: values[7],
              registered_tx: values[8],
              registered_at: values[9],
              attestation_mode: values[10],
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };
  const unused = () => {
    throw new Error("dependency must not be used by agent-create tests");
  };
  return {
    pool: { connect: async () => client } as unknown as Pool,
    audit: { emit: vi.fn(async () => undefined) } as unknown as ExecutionDeps["audit"],
    rails: new RailRegistry([]),
    evaluatePolicy: unused as unknown as ExecutionDeps["evaluatePolicy"],
    evaluatePaymentIntent: unused as unknown as ExecutionDeps["evaluatePaymentIntent"],
    resolveAgent: unused as unknown as ExecutionDeps["resolveAgent"],
    resolveAccount: unused as unknown as ExecutionDeps["resolveAccount"],
    resolveCounterparty: unused as unknown as ExecutionDeps["resolveCounterparty"],
    resolvePrincipal: unused as unknown as ExecutionDeps["resolvePrincipal"],
    resolveRole: unused as unknown as ExecutionDeps["resolveRole"],
  };
}

async function buildApp(
  deps: ExecutionDeps,
  scopes: Scope[],
  opts: { idempotent?: boolean } = {},
): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(requestIdPlugin);
  await app.register(errorHandlerPlugin);
  // Principal hook must be registered before idempotencyPlugin: both add a
  // preHandler hook, they run in registration order, and idempotencyPlugin
  // requires request.principal to already be set (it tenant-scopes the
  // idempotency key by principal.tenantId).
  app.addHook("preHandler", async (request) => {
    request.principal = principalWithScopes(scopes);
  });
  if (opts.idempotent === true) {
    await app.register(idempotencyPlugin, {
      store: new InMemoryIdempotencyStore(),
      ttlSeconds: 86_400,
    });
  }
  await app.register(async (child) => registerExecutionRoutes(child, deps));
  return app;
}

describe("POST /agents - auth (execution:admin OR policy:write)", () => {
  it("accepts a member-role admin token (execution:admin)", async () => {
    const app = await buildApp(agentInsertingDeps(), ["execution:admin"]);
    const res = await app.inject({
      method: "POST",
      url: "/agents",
      payload: { role: "anomaly", display_name: "Admin-created", attestation_mode: "none" },
    });
    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it("accepts a tenant owner token (policy:write)", async () => {
    const app = await buildApp(agentInsertingDeps(), ["policy:write"]);
    const res = await app.inject({
      method: "POST",
      url: "/agents",
      payload: { role: "anomaly", display_name: "Owner-created", attestation_mode: "none" },
    });
    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it("rejects execution:read alone", async () => {
    const app = await buildApp(agentInsertingDeps(), ["execution:read"]);
    const res = await app.inject({
      method: "POST",
      url: "/agents",
      payload: { role: "anomaly", display_name: "Reader", attestation_mode: "none" },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: { code: string } }).error.code).toBe("auth_scope_insufficient");
    await app.close();
  });
});

describe("POST /agents - server mints id and derives scope_hash", () => {
  it("rejects a caller-supplied scope_hash as an unknown field", async () => {
    const app = await buildApp(agentInsertingDeps(), ["execution:admin"]);
    const res = await app.inject({
      method: "POST",
      url: "/agents",
      payload: {
        role: "anomaly",
        display_name: "Hash Faker",
        attestation_mode: "none",
        scope_hash: "ab".repeat(32),
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string; details?: { reason?: string } } };
    expect(body.error.code).toBe("request_body_invalid");
    expect(body.error.details?.reason).toBe("unknown_field");
    await app.close();
  });

  it("rejects a caller-supplied agent_id and state as unknown fields", async () => {
    const app = await buildApp(agentInsertingDeps(), ["execution:admin"]);
    const res = await app.inject({
      method: "POST",
      url: "/agents",
      payload: {
        agent_id: newAgentId(),
        state: "active",
        role: "anomaly",
        display_name: "Id Faker",
        attestation_mode: "none",
      },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe("request_body_invalid");
    await app.close();
  });

  it("derives the canonical scope_hash for the role rather than accepting one", async () => {
    const app = await buildApp(agentInsertingDeps(), ["execution:admin"]);
    const res = await app.inject({
      method: "POST",
      url: "/agents",
      payload: { role: "anomaly", display_name: "Derived Hash", attestation_mode: "none" },
    });
    expect(res.statusCode).toBe(201);
    const canonical = computeAgentScopeHash(scopesForAgentRole("anomaly")).slice(2);
    expect((res.json() as { scope_hash: string }).scope_hash).toBe(canonical);
    await app.close();
  });
});

describe("POST /agents - attestation_mode none requires an unattested-eligible role", () => {
  it("accepts a read-only role (anomaly) as tier-1 unattested", async () => {
    const app = await buildApp(agentInsertingDeps(), ["execution:admin"]);
    const res = await app.inject({
      method: "POST",
      url: "/agents",
      payload: { role: "anomaly", display_name: "Tier-1 Agent", attestation_mode: "none" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { state: string; attestation_mode: string; custodial: boolean };
    expect(body.state).toBe("active");
    expect(body.attestation_mode).toBe("none");
    expect(body.custodial).toBe(false);
    await app.close();
  });

  it("rejects a money-path role (payment) with attestation_mode none", async () => {
    const app = await buildApp(agentInsertingDeps(), ["execution:admin"]);
    const res = await app.inject({
      method: "POST",
      url: "/agents",
      payload: { role: "payment", display_name: "Sneaky Agent", attestation_mode: "none" },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe("request_body_invalid");
    await app.close();
  });

  it("rejects an unknown role before it ever reaches scopesForAgentRole", async () => {
    const app = await buildApp(agentInsertingDeps(), ["execution:admin"]);
    const res = await app.inject({
      method: "POST",
      url: "/agents",
      payload: { role: "not_a_real_role", display_name: "Typo Agent", attestation_mode: "none" },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe("request_body_invalid");
    await app.close();
  });
});

describe("POST /agents - tier 2 (relayer not yet built) / tier 3 (custodial relayer)", () => {
  it("returns agent_rail_unavailable for attestation_mode=tenant_signed", async () => {
    const app = await buildApp(agentInsertingDeps(), ["execution:admin"]);
    const res = await app.inject({
      method: "POST",
      url: "/agents",
      payload: {
        role: "payment",
        display_name: "Tenant Signed Agent",
        attestation_mode: "tenant_signed",
        onchain_address: "0x0000000000000000000000000000000000dEaD",
      },
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { code: string } }).error.code).toBe("agent_rail_unavailable");
    await app.close();
  });

  it("returns agent_rail_unavailable for attestation_mode=onchain_custodial", async () => {
    const app = await buildApp(agentInsertingDeps(), ["execution:admin"]);
    const res = await app.inject({
      method: "POST",
      url: "/agents",
      payload: {
        role: "payment",
        display_name: "Custodial Agent",
        attestation_mode: "onchain_custodial",
        onchain_address: "0x0000000000000000000000000000000000dEaD",
      },
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { code: string } }).error.code).toBe("agent_rail_unavailable");
    await app.close();
  });

  it("requires onchain_address before reporting agent_rail_unavailable", async () => {
    const app = await buildApp(agentInsertingDeps(), ["execution:admin"]);
    const res = await app.inject({
      method: "POST",
      url: "/agents",
      payload: {
        role: "payment",
        display_name: "No Address Agent",
        attestation_mode: "onchain_custodial",
      },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe("request_body_invalid");
    await app.close();
  });

  it("returns 201 pending_onchain for attestation_mode=onchain_custodial when the relayer is configured", async () => {
    const deps = agentInsertingDeps();
    deps.relayer = { configured: true, submitRegistration: vi.fn() };
    const app = await buildApp(deps, ["execution:admin"]);
    const res = await app.inject({
      method: "POST",
      url: "/agents",
      payload: {
        role: "payment",
        display_name: "Custodial Agent",
        attestation_mode: "onchain_custodial",
        onchain_address: "0x0000000000000000000000000000000000dEaD",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { state: string; custodial: boolean };
    expect(body.state).toBe("pending_onchain");
    expect(body.custodial).toBe(true);
    await app.close();
  });

  it("still returns agent_rail_unavailable for onchain_custodial when the relayer is configured=false", async () => {
    const deps = agentInsertingDeps();
    deps.relayer = { configured: false, submitRegistration: vi.fn() };
    const app = await buildApp(deps, ["execution:admin"]);
    const res = await app.inject({
      method: "POST",
      url: "/agents",
      payload: {
        role: "payment",
        display_name: "Custodial Agent",
        attestation_mode: "onchain_custodial",
        onchain_address: "0x0000000000000000000000000000000000dEaD",
      },
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { code: string } }).error.code).toBe("agent_rail_unavailable");
    await app.close();
  });
});

describe("POST /agents - idempotent replay", () => {
  it("returns the stored response on a replayed Idempotency-Key without re-running the handler", async () => {
    const app = await buildApp(agentInsertingDeps(), ["execution:admin"], { idempotent: true });
    const payload = { role: "anomaly", display_name: "Idempotent Agent", attestation_mode: "none" };
    const first = await app.inject({
      method: "POST",
      url: "/agents",
      headers: { "idempotency-key": "idem-key-1" },
      payload,
    });
    expect(first.statusCode).toBe(201);
    const firstBody = first.json() as { id: string };

    const second = await app.inject({
      method: "POST",
      url: "/agents",
      headers: { "idempotency-key": "idem-key-1" },
      payload,
    });
    expect(second.statusCode).toBe(201);
    const secondBody = second.json() as { id: string };
    // Same stored response replayed, not a fresh handler run: a re-run would
    // mint a different newAgentId() each time.
    expect(secondBody.id).toBe(firstBody.id);
    await app.close();
  });
});
