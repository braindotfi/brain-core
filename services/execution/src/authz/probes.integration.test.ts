import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  errorHandlerPlugin,
  newTenantId,
  newUserId,
  requestIdPlugin,
  type Principal,
  type Scope,
} from "@brain/shared";
import type { PaymentIntentService } from "../payment-intents/PaymentIntentService.js";
import { registerPaymentIntentRoutes } from "../payment-intents/routes.js";
import { registerAuthorizationProbeRoutes } from "./probes.js";

function principal(scopes: Scope[]): Principal {
  return {
    id: newUserId(),
    type: "user",
    tenantId: newTenantId(),
    scopes,
    tokenId: "token_authz_probe_integration",
    expiresAt: Math.floor(Date.now() / 1000) + 300,
  };
}

function domainServiceSpies() {
  const calls = {
    create: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
    approve: vi.fn(),
    reject: vi.fn(),
    execute: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    replayInvestigation: vi.fn(),
  };
  return { calls, service: calls as unknown as PaymentIntentService };
}

describe("payment-intent approval authorization probe", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    await app.register(requestIdPlugin);
    await app.register(errorHandlerPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  async function mount(scopes: Scope[]) {
    const { calls, service } = domainServiceSpies();
    app.addHook("preHandler", async (request) => {
      request.principal = principal(scopes);
    });
    await registerPaymentIntentRoutes(app, service);
    await registerAuthorizationProbeRoutes(app);
    return calls;
  }

  function expectNoDomainServiceCalls(calls: ReturnType<typeof domainServiceSpies>["calls"]) {
    for (const call of Object.values(calls)) {
      expect(call).not.toHaveBeenCalled();
    }
  }

  it("returns auth_scope_insufficient without domain calls when scope is missing", async () => {
    const calls = await mount(["execution:read"]);

    const response = await app.inject({
      method: "GET",
      url: "/authz/probes/payment-intent-approve",
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error).toMatchObject({
      code: "auth_scope_insufficient",
      details: { required: "payment_intent:approve", held: ["execution:read"] },
    });
    expectNoDomainServiceCalls(calls);
  });

  it("returns 204 without domain calls when scope is held", async () => {
    const calls = await mount(["payment_intent:approve"]);

    const response = await app.inject({
      method: "GET",
      url: "/authz/probes/payment-intent-approve",
    });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
    expectNoDomainServiceCalls(calls);
  });
});
