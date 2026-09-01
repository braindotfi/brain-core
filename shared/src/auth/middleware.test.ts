import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { extractBearer } from "./middleware.js";
import authPlugin from "./middleware.js";
import requestIdPlugin from "../http/request-id.js";
import type {
  ApiKeyGatewayTelemetryEvent,
  ApiKeyMeterFailureTelemetryEvent,
  ApiKeySecurityTelemetryEvent,
  ApiRequestMeter,
  ApiRequestMeterEvent,
} from "./api-key-metering.js";
import type { JwtVerifier } from "./jwt.js";
import type { Principal } from "./principal.js";
import { requireScope } from "./scopes.js";

describe("extractBearer", () => {
  it("extracts the token when header is well-formed", () => {
    expect(extractBearer("Bearer abc.def.ghi")).toBe("abc.def.ghi");
  });

  it("is case-insensitive on the scheme", () => {
    expect(extractBearer("bearer token")).toBe("token");
    expect(extractBearer("BEARER token")).toBe("token");
  });

  it("trims whitespace around the header", () => {
    expect(extractBearer("  Bearer abc  ")).toBe("abc");
  });

  it("returns null for unknown schemes", () => {
    expect(extractBearer("Basic abc")).toBe(null);
  });

  it("returns null for missing header", () => {
    expect(extractBearer(undefined)).toBe(null);
  });

  it("returns null for empty header", () => {
    expect(extractBearer("")).toBe(null);
    expect(extractBearer("Bearer")).toBe(null);
  });
});

class InMemoryRequestMeter implements ApiRequestMeter {
  public readonly events: ApiRequestMeterEvent[] = [];

  public async record(event: ApiRequestMeterEvent): Promise<void> {
    this.events.push(event);
  }
}

describe("API key request metering", () => {
  const fakePrincipal: Principal = {
    id: "agent_test",
    type: "api_partner",
    tenantId: "tnt_test",
    scopes: ["ledger:read"],
    tokenId: "token_test",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };

  async function buildApp(meter: InMemoryRequestMeter, keyId: string) {
    const app = Fastify({ logger: false });
    await app.register(authPlugin, {
      verifier: {} as unknown as JwtVerifier,
      apiKeyAuthenticator: async (secret: string) =>
        secret === "brain_sk_test_valid" ? { principal: fakePrincipal, keyId } : null,
      apiKeyRequestMeter: meter,
      apiKeyRouteContracts: [
        {
          method: "GET",
          route: "/probe",
          operationId: "meterProbe",
          requiredScope: "ledger:read",
          productFamily: "ledger",
          metered: true,
        },
      ],
    });
    app.get("/probe", async () => ({ ok: true }));
    await app.ready();
    return app;
  }

  it("records one route-attributed event for a successful request", async () => {
    const meter = new InMemoryRequestMeter();
    const app = await buildApp(meter, "akey_direct_test");
    try {
      const res = await app.inject({
        method: "GET",
        url: "/probe",
        headers: { authorization: "Bearer brain_sk_test_valid" },
      });
      expect(res.statusCode).toBe(200);
      expect(meter.events).toHaveLength(1);
      expect(meter.events[0]).toMatchObject({
        keyId: "akey_direct_test",
        operationId: "meterProbe",
        requiredScope: "ledger:read",
        productFamily: "ledger",
        routeTemplate: "/probe",
        statusCode: 200,
        outcome: "success",
      });
    } finally {
      await app.close();
    }
  });

  it("does not trust a repeated client correlation id as meter idempotency", async () => {
    const meter = new InMemoryRequestMeter();
    const app = await buildApp(meter, "akey_direct_test");
    try {
      const request = () =>
        app.inject({
          method: "GET",
          url: "/probe",
          headers: {
            authorization: "Bearer brain_sk_test_valid",
            "x-request-id": "client_reused_id",
          },
        });
      expect((await request()).statusCode).toBe(200);
      expect((await request()).statusCode).toBe(200);
      expect(meter.events).toHaveLength(2);
      expect(new Set(meter.events.map((event) => event.requestId)).size).toBe(2);
      expect(meter.events.map((event) => event.requestId)).not.toContain("client_reused_id");
    } finally {
      await app.close();
    }
  });

  it("attaches an unversioned contract to a route mounted under /v1", async () => {
    const meter = new InMemoryRequestMeter();
    const app = Fastify({ logger: false });
    await app.register(authPlugin, {
      verifier: {} as JwtVerifier,
      apiKeyAuthenticator: async () => ({ principal: fakePrincipal, keyId: "akey_prefixed" }),
      apiKeyRequestMeter: meter,
      apiKeyRouteContracts: [
        {
          method: "GET",
          route: "/ledger/accounts",
          operationId: "listAccounts",
          requiredScope: "ledger:read",
          productFamily: "ledger",
          metered: true,
        },
      ],
    });
    await app.register(
      async (v1) => {
        v1.get("/ledger/accounts", async () => ({ accounts: [] }));
      },
      { prefix: "/v1" },
    );
    await app.ready();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/ledger/accounts",
        headers: { authorization: "Bearer brain_sk_test_valid" },
      });
      expect(response.statusCode).toBe(200);
      expect(meter.events[0]).toMatchObject({
        routeTemplate: "/v1/ledger/accounts",
        operationId: "listAccounts",
        requiredScope: "ledger:read",
      });
    } finally {
      await app.close();
    }
  });

  it("records server failures instead of dropping them", async () => {
    const meter = new InMemoryRequestMeter();
    const app = Fastify({ logger: false });
    await app.register(authPlugin, {
      verifier: {} as unknown as JwtVerifier,
      apiKeyAuthenticator: async (secret: string) =>
        secret === "brain_sk_test_valid"
          ? { principal: fakePrincipal, keyId: "akey_should_not_appear" }
          : null,
      apiKeyRequestMeter: meter,
    });
    app.get("/fails", async (_req, reply) => {
      reply.status(500);
      return { error: "boom" };
    });
    await app.ready();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/fails",
        headers: { authorization: "Bearer brain_sk_test_valid" },
      });
      expect(res.statusCode).toBe(500);
      expect(meter.events).toHaveLength(1);
      expect(meter.events[0]).toMatchObject({
        keyId: "akey_should_not_appear",
        statusCode: 500,
        outcome: "server_error",
      });
    } finally {
      await app.close();
    }
  });
});

describe("concurrent API key request attribution", () => {
  const fakePrincipal: Principal = {
    id: "agent_test",
    type: "api_partner",
    tenantId: "tnt_test",
    scopes: ["ledger:read"],
    tokenId: "token_test",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };

  it("keeps two concurrent keys' events correctly isolated with no crossover", async () => {
    const meter = new InMemoryRequestMeter();
    const app = Fastify({ logger: false });
    await app.register(requestIdPlugin);
    await app.register(authPlugin, {
      verifier: {} as unknown as JwtVerifier, // unused: only the api-key path is exercised
      apiKeyAuthenticator: async (secret: string) => {
        if (secret === "brain_sk_test_A") return { principal: fakePrincipal, keyId: "akey_A" };
        if (secret === "brain_sk_test_B") return { principal: fakePrincipal, keyId: "akey_B" };
        return null;
      },
      apiKeyRequestMeter: meter,
    });
    app.get("/probe", async () => ({ ok: true }));
    await app.ready();
    try {
      // Both batches fire immediately (Array.from invokes app.inject eagerly),
      // so key A and key B requests are genuinely in flight concurrently on
      // the same app / same shared emitter.
      const results = await Promise.all([
        ...Array.from({ length: 10 }, () =>
          app.inject({
            method: "GET",
            url: "/probe",
            headers: { authorization: "Bearer brain_sk_test_A" },
          }),
        ),
        ...Array.from({ length: 10 }, () =>
          app.inject({
            method: "GET",
            url: "/probe",
            headers: { authorization: "Bearer brain_sk_test_B" },
          }),
        ),
      ]);
      for (const res of results) {
        expect(res.statusCode).toBe(200);
      }

      expect(meter.events).toHaveLength(20);
      expect(meter.events.filter((e) => e.keyId === "akey_A")).toHaveLength(10);
      expect(meter.events.filter((e) => e.keyId === "akey_B")).toHaveLength(10);
      expect(meter.events.every((e) => e.keyId === "akey_A" || e.keyId === "akey_B")).toBe(true);
    } finally {
      await app.close();
    }
  });
});

describe("API key rejection separation", () => {
  const principal: Principal = {
    id: "akey_known",
    type: "api_partner",
    tenantId: "tnt_01M0KHRVY3RT3EXN7WT2SPDFMZ",
    scopes: ["ledger:read"],
    tokenId: "akey_known",
    expiresAt: Number.MAX_SAFE_INTEGER,
  };

  it("meters a known rate-limit rejection with its exact decision", async () => {
    const meter = new InMemoryRequestMeter();
    const app = Fastify({ logger: false });
    await app.register(authPlugin, {
      verifier: {} as JwtVerifier,
      apiKeyRequestMeter: meter,
      apiKeyRateLimitWindowSeconds: 60,
      apiKeyAuthenticator: async () => ({
        kind: "known_rejected",
        attribution: {
          keyId: "akey_known",
          tenantId: principal.tenantId,
          environment: "sandbox",
          accessStage: "demo",
        },
        reason: "rate_limited",
        rateLimit: {
          allowed: false,
          count: 601,
          limit: 600,
          tenantCount: 610,
          tenantLimit: 6000,
          rejectedBy: "key",
          policy: {
            tierId: "sandbox_demo_v1",
            entitlementVersion: 1,
            windowSeconds: 60,
            keyLimit: 600,
            tenantLimit: 6000,
          },
        },
      }),
    });
    app.get("/limited", async () => ({ ok: true }));
    await app.ready();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/limited",
        headers: { authorization: "Bearer brain_sk_test_known" },
      });
      expect(response.statusCode).toBe(429);
      expect(meter.events).toHaveLength(1);
      expect(meter.events[0]).toMatchObject({
        tenantId: principal.tenantId,
        keyId: "akey_known",
        outcome: "rate_limited",
        rejectionReason: "rate_limited",
        rateLimitCount: 601,
        rateLimitValue: 600,
        rateLimitWindowSeconds: 60,
        effectiveTierId: "sandbox_demo_v1",
        entitlementVersion: 1,
        rateLimitTenantCount: 610,
        rateLimitTenantValue: 6000,
        rateLimitRejectedBy: "key",
      });
      expect(response.headers).toMatchObject({
        "ratelimit-limit": "600",
        "ratelimit-remaining": "0",
        "ratelimit-reset": "60",
        "x-ratelimit-tier": "sandbox_demo_v1",
        "x-ratelimit-tenant-limit": "6000",
      });
    } finally {
      await app.close();
    }
  });

  it("records unknown credentials only in security telemetry", async () => {
    const meter = new InMemoryRequestMeter();
    const securityEvents: ApiKeySecurityTelemetryEvent[] = [];
    const app = Fastify({ logger: false });
    await app.register(authPlugin, {
      verifier: {} as JwtVerifier,
      apiKeyRequestMeter: meter,
      apiKeySecurityTelemetry: { record: (event) => securityEvents.push(event) },
      apiKeyAuthenticator: async () => ({ kind: "unknown_rejected", reason: "unknown" }),
    });
    app.get("/probe", async () => ({ ok: true }));
    await app.ready();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/probe",
        headers: { authorization: "Bearer brain_sk_test_not_a_match" },
      });
      expect(response.statusCode).toBe(401);
      expect(meter.events).toHaveLength(0);
      expect(securityEvents).toEqual([
        expect.objectContaining({ reason: "unknown", routeTemplate: "/probe" }),
      ]);
      expect(JSON.stringify(securityEvents)).not.toContain("brain_sk_test_not_a_match");
    } finally {
      await app.close();
    }
  });

  it("fails closed and meters a known key when the entitlement limiter is unavailable", async () => {
    const meter = new InMemoryRequestMeter();
    const app = Fastify({ logger: false });
    await app.register(authPlugin, {
      verifier: {} as JwtVerifier,
      apiKeyRequestMeter: meter,
      apiKeyAuthenticator: async () => ({
        kind: "known_rejected",
        attribution: {
          keyId: "akey_known",
          tenantId: principal.tenantId,
          environment: "sandbox",
          accessStage: "demo",
        },
        reason: "rate_limiter_unavailable",
        rateLimitPolicy: {
          tierId: "sandbox_demo_v1",
          entitlementVersion: 1,
          windowSeconds: 60,
          keyLimit: 600,
          tenantLimit: 6000,
        },
      }),
    });
    app.get("/redis-down", async () => ({ ok: true }));
    await app.ready();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/redis-down",
        headers: { authorization: "Bearer brain_sk_test_known" },
      });
      expect(response.statusCode).toBe(503);
      expect(meter.events).toEqual([
        expect.objectContaining({
          tenantId: principal.tenantId,
          keyId: "akey_known",
          outcome: "server_error",
          rejectionReason: "rate_limiter_unavailable",
          effectiveTierId: "sandbox_demo_v1",
          entitlementVersion: 1,
        }),
      ]);
    } finally {
      await app.close();
    }
  });

  it("emits reconcilable gateway and limiter decision telemetry for known keys", async () => {
    const meter = new InMemoryRequestMeter();
    const gatewayEvents: ApiKeyGatewayTelemetryEvent[] = [];
    const app = Fastify({ logger: false });
    await app.register(authPlugin, {
      verifier: {} as JwtVerifier,
      apiKeyRequestMeter: meter,
      apiKeyGatewayTelemetry: { record: (event) => gatewayEvents.push(event) },
      apiKeyAuthenticator: async () => ({
        kind: "authenticated",
        principal,
        keyId: "akey_known",
        attribution: {
          keyId: "akey_known",
          tenantId: principal.tenantId,
          environment: "live",
          accessStage: "production",
        },
        rateLimit: {
          allowed: true,
          count: 1,
          limit: 60,
          tenantCount: 1,
          tenantLimit: 600,
          rejectedBy: null,
          policy: {
            tierId: "starter_v1",
            entitlementVersion: 1,
            windowSeconds: 60,
            keyLimit: 60,
            tenantLimit: 600,
          },
        },
      }),
    });
    app.get("/probe", async () => ({ ok: true }));
    await app.ready();
    try {
      await app.inject({
        method: "GET",
        url: "/probe",
        headers: { authorization: "Bearer brain_sk_live_known" },
      });
      expect(gatewayEvents).toEqual([
        expect.objectContaining({
          tenantId: principal.tenantId,
          keyId: "akey_known",
          environment: "live",
          limiterDecision: true,
        }),
      ]);
    } finally {
      await app.close();
    }
  });

  it("emits a completeness signal when the durable meter append fails", async () => {
    const failures: ApiKeyMeterFailureTelemetryEvent[] = [];
    const app = Fastify({ logger: false });
    await app.register(authPlugin, {
      verifier: {} as JwtVerifier,
      apiKeyMeterFailureTelemetry: { record: (event) => failures.push(event) },
      apiKeyRequestMeter: {
        record: async () => {
          throw new Error("database unavailable");
        },
      },
      apiKeyAuthenticator: async () => ({
        kind: "authenticated",
        principal,
        keyId: "akey_known",
        attribution: {
          keyId: "akey_known",
          tenantId: principal.tenantId,
          environment: "sandbox",
          accessStage: "demo",
        },
      }),
    });
    app.get("/probe", async () => ({ ok: true }));
    await app.ready();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/probe",
        headers: { authorization: "Bearer brain_sk_test_known" },
      });
      expect(response.statusCode).toBe(200);
      expect(failures).toEqual([
        expect.objectContaining({ tenantId: principal.tenantId, keyId: "akey_known" }),
      ]);
    } finally {
      await app.close();
    }
  });

  it("fails closed before sending a billable response when configured after shadow", async () => {
    const app = Fastify({ logger: false });
    await app.register(authPlugin, {
      verifier: {} as JwtVerifier,
      apiKeyMeterFailureMode: "billable_fail_closed",
      apiKeyRequestMeter: {
        record: async () => {
          throw new Error("database unavailable");
        },
      },
      apiKeyAuthenticator: async () => ({
        kind: "authenticated",
        principal,
        keyId: "akey_live",
        attribution: {
          keyId: "akey_live",
          tenantId: principal.tenantId,
          environment: "live",
          accessStage: "production",
        },
      }),
    });
    app.get("/probe", async () => ({ ok: true }));
    await app.ready();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/probe",
        headers: { authorization: "Bearer brain_sk_live_known" },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json().message).toBe("API request meter is unavailable");
    } finally {
      await app.close();
    }
  });

  it("records the declared missing scope for a known key", async () => {
    const meter = new InMemoryRequestMeter();
    const app = Fastify({ logger: false });
    await app.register(authPlugin, {
      verifier: {} as JwtVerifier,
      apiKeyRequestMeter: meter,
      apiKeyRouteContracts: [
        {
          method: "GET",
          route: "/raw-probe",
          operationId: "rawProbe",
          requiredScope: "raw:read",
          productFamily: "raw",
          metered: true,
        },
      ],
      apiKeyAuthenticator: async () => ({
        kind: "authenticated",
        principal,
        keyId: "akey_known",
        attribution: {
          keyId: "akey_known",
          tenantId: principal.tenantId,
          environment: "sandbox",
          accessStage: "demo",
        },
      }),
    });
    app.get("/raw-probe", async (request) => {
      requireScope(request.principal!.scopes, "raw:read");
      return { ok: true };
    });
    await app.ready();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/raw-probe",
        headers: { authorization: "Bearer brain_sk_test_known" },
      });
      expect(response.statusCode).toBe(403);
      expect(meter.events[0]).toMatchObject({
        operationId: "rawProbe",
        requiredScope: "raw:read",
        outcome: "scope_rejected",
        rejectionReason: "auth_scope_insufficient",
      });
    } finally {
      await app.close();
    }
  });
});

describe("optional auth on skipAuth routes", () => {
  const fakePrincipal: Principal = {
    id: "akey_optional",
    type: "api_partner",
    tenantId: "tnt_optional",
    scopes: ["governance:read"],
    tokenId: "akey_optional",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };

  it("allows no bearer but authenticates a bearer when one is present", async () => {
    const app = Fastify({ logger: false });
    await app.register(authPlugin, {
      verifier: {} as unknown as JwtVerifier,
      apiKeyAuthenticator: async (secret: string) =>
        secret === "brain_sk_test_optional"
          ? { principal: fakePrincipal, keyId: "akey_optional" }
          : null,
    });
    app.get("/optional", { config: { skipAuth: true, optionalAuth: true } }, async (request) => ({
      principal_id: request.principal?.id ?? null,
      key_id: request.apiKeyId ?? null,
    }));
    await app.ready();
    try {
      const anonymous = await app.inject({ method: "GET", url: "/optional" });
      expect(anonymous.statusCode).toBe(200);
      expect(anonymous.json()).toEqual({ principal_id: null, key_id: null });

      const authenticated = await app.inject({
        method: "GET",
        url: "/optional",
        headers: { authorization: "Bearer brain_sk_test_optional" },
      });
      expect(authenticated.statusCode).toBe(200);
      expect(authenticated.json()).toEqual({
        principal_id: "akey_optional",
        key_id: "akey_optional",
      });
    } finally {
      await app.close();
    }
  });
});
