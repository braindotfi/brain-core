/**
 * RFC F2 regression: POST /execution/propose must bind a caller-supplied
 * X-Brain-Write-Tenant the same HMAC-verified way Raw's
 * POST /raw/{id}/parsed already does (services/raw/src/routes/parsed.ts),
 * so a static golden-tenant agent JWT writes the proposal -- and its
 * execution.propose audit event -- into the caller's real tenant instead of
 * the token's tenant. Must fail against pre-fix routes.ts, which always used
 * principal.tenantId with no cross-tenant header support at all.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  computeServiceAuthSignature,
  errorHandlerPlugin,
  newAgentId,
  newProposalId,
  newTenantId,
  requestIdPlugin,
  type Principal,
  type Scope,
} from "@brain/shared";
import type { Pool } from "pg";
import type { ExecutionDeps } from "./deps.js";
import { RailRegistry } from "./rails/stubs.js";
import { registerExecutionRoutes } from "./routes.js";

const JWT_TENANT = newTenantId();
const WRITE_TENANT = newTenantId();
const AGENT = newAgentId();
const SECRET = "shared-secret";

function principal(scopes: Scope[]): Principal {
  return {
    id: AGENT,
    type: "agent",
    tenantId: JWT_TENANT,
    scopes,
    tokenId: "tok_01TEST0000000000000000000",
    expiresAt: Math.floor(Date.now() / 1000) + 900,
  };
}

async function buildApp(p: Principal): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(requestIdPlugin);
  await app.register(errorHandlerPlugin);
  app.addHook("preHandler", async (request) => {
    request.principal = p;
  });
  return app;
}

interface Captured {
  insertedTenant?: string;
  policyTenant?: string;
  auditTenant?: string;
}

function executionDeps(captured: Captured, crossTenantServiceSecret?: string): ExecutionDeps {
  const client = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (sql.startsWith("SELECT set_config")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("INSERT INTO proposals")) {
        captured.insertedTenant = values[1] as string;
        return {
          rows: [
            {
              id: newProposalId(),
              tenant_id: values[1],
              proposing_agent: values[2],
              action: JSON.parse(values[3] as string),
              policy_version: values[4],
              policy_decision: values[5],
              policy_trace: [],
              required_approvers: [],
              status: values[8],
              approvers_signed: [],
              proposal_dedup_key: null,
              created_at: new Date("2026-01-01T00:00:00.000Z"),
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
    throw new Error("dependency must not be used by propose cross-tenant tests");
  };
  return {
    pool: { connect: async () => client } as unknown as Pool,
    audit: {
      emit: vi.fn(async (event: { tenantId: string }) => {
        captured.auditTenant = event.tenantId;
      }),
    } as unknown as ExecutionDeps["audit"],
    rails: new RailRegistry([]),
    evaluatePolicy: async (tenantId: string) => {
      captured.policyTenant = tenantId;
      return {
        outcome: "allow" as const,
        matched_rule_id: null,
        required_approvers: [],
        trace: [],
        policy_version: 1,
      };
    },
    evaluatePaymentIntent: unused as unknown as ExecutionDeps["evaluatePaymentIntent"],
    resolveAgent: unused as unknown as ExecutionDeps["resolveAgent"],
    resolveAccount: unused as unknown as ExecutionDeps["resolveAccount"],
    resolveCounterparty: unused as unknown as ExecutionDeps["resolveCounterparty"],
    resolvePrincipal: unused as unknown as ExecutionDeps["resolvePrincipal"],
    resolveRole: unused as unknown as ExecutionDeps["resolveRole"],
    ...(crossTenantServiceSecret !== undefined ? { crossTenantServiceSecret } : {}),
  };
}

describe("POST /execution/propose cross-tenant binding (RFC F2)", () => {
  it("writes into X-Brain-Write-Tenant when the HMAC verifies and a service secret is configured", async () => {
    const captured: Captured = {};
    const app = await buildApp(principal(["execution:propose"]));
    await registerExecutionRoutes(app, executionDeps(captured, SECRET));

    const body = JSON.stringify({ action: { kind: "reconciliation" }, agent_id: AGENT });
    const signature = computeServiceAuthSignature(SECRET, Buffer.from(body, "utf8"));

    const res = await app.inject({
      method: "POST",
      url: "/execution/propose",
      headers: {
        "content-type": "application/json",
        "x-brain-write-tenant": WRITE_TENANT,
        "x-brain-service-auth": signature,
      },
      payload: body,
    });

    expect(res.statusCode).toBe(201);
    expect(captured.insertedTenant).toBe(WRITE_TENANT);
    expect(captured.policyTenant).toBe(WRITE_TENANT);
    expect(captured.auditTenant).toBe(WRITE_TENANT);
    await app.close();
  });

  it("falls back to the JWT tenant when the signature is wrong", async () => {
    const captured: Captured = {};
    const app = await buildApp(principal(["execution:propose"]));
    await registerExecutionRoutes(app, executionDeps(captured, SECRET));

    const body = JSON.stringify({ action: { kind: "reconciliation" }, agent_id: AGENT });

    const res = await app.inject({
      method: "POST",
      url: "/execution/propose",
      headers: {
        "content-type": "application/json",
        "x-brain-write-tenant": WRITE_TENANT,
        "x-brain-service-auth": "sha256=" + "0".repeat(64),
      },
      payload: body,
    });

    expect(res.statusCode).toBe(201);
    expect(captured.insertedTenant).toBe(JWT_TENANT);
    await app.close();
  });

  it("falls back to the JWT tenant when no service secret is configured, even with headers present", async () => {
    const captured: Captured = {};
    const app = await buildApp(principal(["execution:propose"]));
    await registerExecutionRoutes(app, executionDeps(captured)); // no secret configured

    const body = JSON.stringify({ action: { kind: "reconciliation" }, agent_id: AGENT });
    const signature = computeServiceAuthSignature("some-other-secret", Buffer.from(body, "utf8"));

    const res = await app.inject({
      method: "POST",
      url: "/execution/propose",
      headers: {
        "content-type": "application/json",
        "x-brain-write-tenant": WRITE_TENANT,
        "x-brain-service-auth": signature,
      },
      payload: body,
    });

    expect(res.statusCode).toBe(201);
    expect(captured.insertedTenant).toBe(JWT_TENANT);
    await app.close();
  });

  it("still pins proposing agent identity independent of tenant resolution", async () => {
    const captured: Captured = {};
    const app = await buildApp(principal(["execution:propose"]));
    await registerExecutionRoutes(app, executionDeps(captured, SECRET));

    const body = JSON.stringify({ action: { kind: "reconciliation" } });
    const signature = computeServiceAuthSignature(SECRET, Buffer.from(body, "utf8"));

    const res = await app.inject({
      method: "POST",
      url: "/execution/propose",
      headers: {
        "content-type": "application/json",
        "x-brain-write-tenant": WRITE_TENANT,
        "x-brain-service-auth": signature,
      },
      payload: body,
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().proposing_agent).toBe(AGENT);
    await app.close();
  });
});
